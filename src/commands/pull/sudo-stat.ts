/**
 * Resolves sudo targets whose lstat failed (parent directory not searchable)
 * through the privileged worker, and rejects symlinks over directories.
 */
import { buildNewFileDiff, buildNewSymlinkDiff, FileDiff } from '../../diff';
import { closeAllSessions, sudoStatBatch, WriteTarget } from '../../writer';
import { abortWithSessions } from './sudo-sessions';
import { FileHookContext, PullRun } from './types';

type StatResults = Awaited<ReturnType<typeof sudoStatBatch>>;
type StatResult = NonNullable<ReturnType<StatResults['get']>>;
type ModeChange = FileDiff['modeChange'];

interface StatRequest {
  filePath: string;
  sudo: true | string;
}

function lstatFailedRequests(run: PullRun): StatRequest[] {
  const { writeTargets, allDiffs } = run.state;
  const stale = run.stale;
  return [
    ...writeTargets.flatMap((t, i) =>
      allDiffs[i].lstatFailed && t.sudo
        ? [{ filePath: t.targetPath, sudo: t.sudo }]
        : [],
    ),
    ...stale.toRestore.flatMap((t, i) => {
      const diffIdx = stale.restoreDiffIndices[i];
      return stale.diffs[diffIdx]?.lstatFailed && t.sudo
        ? [{ filePath: t.targetPath, sudo: t.sudo }]
        : [];
    }),
  ];
}

function newDiffFor(
  diffPath: string,
  target: WriteTarget,
  modeChange: ModeChange,
): FileDiff {
  if (target.symlinkTarget !== undefined) {
    return buildNewSymlinkDiff(diffPath, target.symlinkTarget);
  }
  return buildNewFileDiff(diffPath, target.content, modeChange);
}

function isDirectoryConflict(target: WriteTarget, stat: StatResult): boolean {
  return (
    target.symlinkTarget !== undefined && !stat.isSymlink && stat.isDirectory
  );
}

function statModeChange(
  desiredMode: string | undefined,
  stat: StatResult | undefined,
  fallback: ModeChange,
): ModeChange {
  const actualModeStr = stat?.mode;
  if (!desiredMode || !actualModeStr || !stat?.exists) return fallback;
  const desired = parseInt(desiredMode.replace(/^0[oO]/, ''), 8);
  const current = parseInt(actualModeStr, 8);
  if (isNaN(desired) || isNaN(current) || desired === current) {
    return undefined;
  }
  return { from: current, to: desired };
}

function setHookIsNew(
  contexts: FileHookContext[],
  targetPath: string,
  isNew: boolean,
): void {
  const hookIdx = contexts.findIndex((ctx) => ctx.targetPath === targetPath);
  if (hookIdx >= 0) {
    contexts[hookIdx] = { ...contexts[hookIdx], isNew };
  }
}

function refreshWriteTarget(run: PullRun, i: number, stats: StatResults): void {
  const { writeTargets, allDiffs } = run.state;
  const target = writeTargets[i];
  const diff = allDiffs[i];
  if (!diff.lstatFailed || !target.sudo) return;
  const stat = stats.get(target.targetPath);
  if (stat?.isSpecialFile) {
    console.warn(
      `Warning: ${target.targetPath} is a special file (FIFO/socket/device); skipping write`,
    );
    allDiffs[i] = { ...diff, hasChanges: false, isNew: false };
    writeTargets[i] = { ...target, backupPath: undefined };
    return;
  }
  const modeChange = statModeChange(target.mode, stat, diff.modeChange);
  const isNew = !stat?.exists;
  if (stat?.exists) {
    // exists is true here, so the stat-read result is present.
    const updatedDiff: FileDiff = { ...diff, isNew, modeChange };
    allDiffs[i] = isDirectoryConflict(target, stat)
      ? { ...updatedDiff, isDirectory: true }
      : updatedDiff;
  } else {
    allDiffs[i] = newDiffFor(diff.targetPath, target, modeChange);
    writeTargets[i] = { ...target, backupPath: undefined };
  }
  setHookIsNew(run.state.fileHookContexts, target.targetPath, isNew);
}

function refreshStaleRestore(
  run: PullRun,
  i: number,
  stats: StatResults,
): void {
  const stale = run.stale;
  const diffIdx = stale.restoreDiffIndices[i];
  const entry = stale.toRestore[i];
  if (!stale.diffs[diffIdx]?.lstatFailed || !entry.sudo) return;
  const stat = stats.get(entry.targetPath);
  if (!stat) return;
  if (!stat.exists) {
    stale.diffs[diffIdx] = newDiffFor(
      entry.targetPath,
      entry,
      stale.diffs[diffIdx]?.modeChange,
    );
    stale.toRestore[i] = { ...entry, backupPath: undefined };
  } else if (isDirectoryConflict(entry, stat)) {
    stale.diffs[diffIdx] = { ...stale.diffs[diffIdx], isDirectory: true };
  }
}

/**
 * Second conflict pass: detect directory conflicts surfaced by the stat-reads
 * (lstatFailed targets whose parent was non-searchable). By this point
 * sessions are open and the user has confirmed — aborting here is correct but
 * happens after the sudo password prompt, unlike the first pass in the fetch
 * loop.
 */
function rejectDirectoryConflicts(run: PullRun): void {
  let hasDirConflict = false;
  for (const d of [...run.state.allDiffs, ...run.stale.diffs]) {
    if (d?.isDirectory && d?.isSymlink) {
      console.error(
        `symlink: ${d.targetPath} is a directory; cannot replace with a symlink`,
      );
      hasDirConflict = true;
    }
  }
  if (hasDirConflict) {
    closeAllSessions(run.sessions);
    process.exit(2);
  }
}

/**
 * For entries where lstatSync failed (parent directory not searchable),
 * batch one stat-read op per sudo identity to determine existence, type,
 * and mode without spawning separate sudo processes.
 */
export async function resolveLstatFailedTargets(run: PullRun): Promise<void> {
  const batch = lstatFailedRequests(run);
  let stats: StatResults = new Map();
  if (batch.length > 0) {
    try {
      stats = await sudoStatBatch(batch, run.sessions);
    } catch (err) {
      abortWithSessions(run, 'stat-read failed: ', err);
    }
  }
  for (let i = 0; i < run.state.writeTargets.length; i++) {
    refreshWriteTarget(run, i, stats);
  }
  for (let i = 0; i < run.stale.toRestore.length; i++) {
    refreshStaleRestore(run, i, stats);
  }
  rejectDirectoryConflicts(run);
}
