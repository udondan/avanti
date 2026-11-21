/** Applies a confirmed pull: content writes, stale cleanup, chmods, hooks. */
import * as fs from 'fs';
import { FileDiff } from '../../diff';
import { PullLogFileRef } from '../../history';
import {
  AtomicWritePartialError,
  atomicWrite,
  closeAllSessions,
  SudoChmodTarget,
  SudoWritePartialError,
  SudoWriteTarget,
  sudoAtomicWrite,
  WriteTarget,
} from '../../writer';
import { errorMessage } from './common';
import { runPostWriteHooks } from './hooks';
import { recordPartialHistory } from './history-record';
import {
  CleanupProgress,
  deleteRegularStale,
  deleteSudoStale,
} from './stale-delete';
import { PullRun } from './types';

/**
 * Also include isNew entries: a new file with empty content produces
 * hasChanges=false ('' !== '' is false) but still needs to be created.
 * Exclude mode-only targets (sudo or not): they have hasChanges=true (due
 * to the mode drift) but contentChanged=false. These flow through the
 * chmod paths — including them here would cause a redundant full-file
 * rewrite and double-count them in the final "Wrote N file(s)." tally.
 */
function isContentWrite(d: FileDiff): boolean {
  if (!d.hasChanges && !d.isNew) return false;
  return d.contentChanged !== false || !d.modeChange;
}

// Mode changes are never computed on Windows (and sudo is rejected there),
// so the chmod paths below need no platform guard of their own.
function modeOnlySudoTargetsOf(run: PullRun): SudoChmodTarget[] {
  const { writeTargets, allDiffs } = run.state;
  return writeTargets.flatMap((t, i) => {
    const d = allDiffs[i];
    return d.modeChange && !d.contentChanged && t.sudo
      ? [
          {
            targetPath: t.targetPath,
            mode: d.modeChange.to.toString(8).padStart(4, '0'),
            sudo: t.sudo,
          },
        ]
      : [];
  });
}

/** What the write phase will change, computed before history staging. */
interface WritePlan {
  changedTargets: WriteTarget[];
  /**
   * Stale restore targets whose diff still has changes (not suppressed by the
   * idempotency check). Also includes diffs where isNew is true: a missing
   * file with empty v0 produces hasChanges=false but still needs writing.
   */
  activeStaleRestore: WriteTarget[];
  modeOnlySudoTargets: SudoChmodTarget[];
}

export function buildWritePlan(run: PullRun): WritePlan {
  const { writeTargets, allDiffs } = run.state;
  const stale = run.stale;
  return {
    changedTargets: writeTargets.filter((_, i) => isContentWrite(allDiffs[i])),
    activeStaleRestore: stale.toRestore.filter((_, i) => {
      const d = stale.diffs[stale.restoreDiffIndices[i]];
      return d.hasChanges || d.isNew;
    }),
    modeOnlySudoTargets: modeOnlySudoTargetsOf(run),
  };
}

/** Write progress, tracked so a failure can record partial history. */
interface WriteProgress extends CleanupProgress {
  /**
   * Set to true once sudoAtomicWrite returns without throwing. Used in the
   * catch block to detect when atomicWrite threw after all sudo files landed
   * on disk — those files need partial history even though err is a plain
   * Error. Only set when sudoAtomicWrite is actually invoked.
   */
  sudoWriteComplete: boolean;
  /**
   * Paths of regular files written, set once atomicWrite returns. A later
   * failure (e.g. a mode-only chmod) is a plain Error, so the catch block
   * uses this to know these files landed.
   */
  regularWrittenPaths: string[];
}

const isSudoTarget = (t: WriteTarget): t is SudoWriteTarget => !!t.sudo;

/**
 * Content writes go first so that if atomicWrite throws, no permissions
 * have been changed yet (minimises partial-apply surface). Privileged writes
 * go before unprivileged ones: if sudo fails, unprivileged files have not yet
 * changed. Chmod-only sudo targets are batched into the same per-identity
 * exec as content writes. Returns the number of sudo chmod-only changes.
 */
async function writeContent(
  run: PullRun,
  plan: WritePlan,
  progress: WriteProgress,
): Promise<number> {
  const { changedTargets, activeStaleRestore, modeOnlySudoTargets } = plan;
  const sudoWrites = [
    ...changedTargets.filter(isSudoTarget),
    ...activeStaleRestore.filter(isSudoTarget),
  ];
  let modeOnlyCount = 0;
  if (sudoWrites.length > 0 || modeOnlySudoTargets.length > 0) {
    modeOnlyCount = await sudoAtomicWrite(
      sudoWrites,
      modeOnlySudoTargets,
      run.sessions,
    );
    progress.sudoWriteComplete = true;
  }
  const regularWrites = [
    ...changedTargets.filter((t) => !t.sudo),
    ...activeStaleRestore.filter((t) => !t.sudo),
  ];
  atomicWrite(regularWrites);
  progress.regularWrittenPaths = regularWrites.map((t) => t.targetPath);
  return modeOnlyCount;
}

/**
 * Active stale restores were all written (atomicWrite throws on failure).
 * No-op stale restores (file already matches v0) are also cleaned so their
 * refs are removed from history and the cleanup does not repeat.
 */
function markRestoresCleaned(run: PullRun, progress: WriteProgress): void {
  for (const t of run.stale.toRestore) {
    progress.effectivelyCleaned.add(t.targetPath);
  }
}

/** Non-sudo mode-only changes (POSIX only: Windows has no modeChange). */
function applyRegularModeChanges(run: PullRun): number {
  const { writeTargets, allDiffs } = run.state;
  let count = 0;
  for (let i = 0; i < writeTargets.length; i++) {
    const d = allDiffs[i];
    if (!d.modeChange || d.contentChanged || writeTargets[i].sudo) continue;
    const lst = fs.lstatSync(writeTargets[i].targetPath, {
      throwIfNoEntry: false,
    });
    if (lst && !lst.isSymbolicLink()) {
      fs.chmodSync(writeTargets[i].targetPath, d.modeChange.to);
      count++;
    }
  }
  return count;
}

async function writeAll(
  run: PullRun,
  plan: WritePlan,
  progress: WriteProgress,
): Promise<string | null> {
  let modeOnlyCount = await writeContent(run, plan, progress);
  markRestoresCleaned(run, progress);
  // Deletions are deferred until both write batches succeed so that
  // stale files are not removed if a later write batch fails.
  deleteRegularStale(run, progress);
  await deleteSudoStale(run, progress);
  modeOnlyCount += applyRegularModeChanges(run);
  const written =
    plan.changedTargets.length +
    plan.activeStaleRestore.length +
    progress.effectivelyDeleted.size +
    modeOnlyCount;
  if (written === 0) {
    // Idempotency checks cleared all diffs after the user confirmed —
    // every target already matches its desired state.
    console.log('Nothing to do.');
  } else {
    console.log(`Wrote ${written} file(s).`);
  }
  return runPostWriteHooks(run.state.fileHookContexts);
}

/**
 * Paths that landed on disk before the failure. Three cases (combinable):
 *  a) SudoWritePartialError: err.writtenPaths lists confirmed sudo writes.
 *  b) AtomicWritePartialError: err.writtenPaths lists regular files whose
 *     renames or in-place writes completed. If atomicWrite itself returned,
 *     regularWrittenPaths lists them all.
 *  c) sudoWriteComplete: sudoAtomicWrite returned, so all sudo content-write
 *     targets are on disk regardless of error type.
 */
function landedPaths(
  err: unknown,
  plan: WritePlan,
  progress: WriteProgress,
  staged: PullLogFileRef[],
): string[] {
  if (err instanceof SudoWritePartialError) return err.writtenPaths;
  const regularWritten =
    err instanceof AtomicWritePartialError
      ? err.writtenPaths
      : progress.regularWrittenPaths;
  if (!progress.sudoWriteComplete) return regularWritten;
  // Exclude chmod-only targets — they went through sudoAtomicWrite as
  // chmodOps (no content write), so no new version was staged.
  const modeOnlySudoPaths = new Set(
    plan.modeOnlySudoTargets.map((t) => t.targetPath),
  );
  return [
    ...staged
      .filter((r) => r.sudo && !modeOnlySudoPaths.has(r.absolutePath))
      .map((r) => r.absolutePath),
    ...plan.activeStaleRestore.filter((t) => t.sudo).map((t) => t.targetPath),
    ...regularWritten,
  ];
}

/**
 * Runs the write phase. Returns the stale paths resolved this pull and the
 * first post-write hook error. Any write failure records partial history,
 * prints "Write failed" and exits with code 2.
 */
export async function applyWrites(
  run: PullRun,
  plan: WritePlan,
  staged: PullLogFileRef[],
): Promise<{ effectivelyCleaned: Set<string>; postWriteError: string | null }> {
  const progress: WriteProgress = {
    effectivelyDeleted: new Set(),
    effectivelyCleaned: new Set(),
    sudoWriteComplete: false,
    regularWrittenPaths: [],
  };
  try {
    const postWriteError = await writeAll(run, plan, progress);
    return { effectivelyCleaned: progress.effectivelyCleaned, postWriteError };
  } catch (err: unknown) {
    const { pullId } = run;
    if (pullId) {
      const writtenPaths = landedPaths(err, plan, progress, staged);
      if (writtenPaths.length > 0) {
        recordPartialHistory(
          run,
          pullId,
          writtenPaths,
          staged,
          plan.activeStaleRestore,
        );
      }
    }
    closeAllSessions(run.sessions);
    console.error(`Write failed: ${errorMessage(err)}`);
    process.exit(2);
  }
}
