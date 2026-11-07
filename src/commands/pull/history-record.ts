/** Records pull results in history: staged versions, partial and final pull logs. */
import { normalizeConfigKey } from '../../config';
import {
  HistoryManager,
  InsertedFragment,
  PullLogFileRef,
  SourceShaRecord,
} from '../../history';
import { FileDiff } from '../../diff';
import { WriteTarget } from '../../writer';
import { PullRun } from './types';

// Merges new file refs into the surviving refs from the last pull.
// Paths in excludePaths and paths already present in newRefs are dropped from
// lastFiles so the three caller sites (stale-only, success, partial-failure)
// share one definition of "surviving refs" rather than duplicating the logic.
export function mergeLastPullRefs(
  lastFiles: PullLogFileRef[],
  excludePaths: Set<string>,
  newRefs: PullLogFileRef[],
): PullLogFileRef[] {
  const newPaths = new Set(newRefs.map((r) => r.absolutePath));
  return [
    ...lastFiles.filter(
      (r) => !excludePaths.has(r.absolutePath) && !newPaths.has(r.absolutePath),
    ),
    ...newRefs,
  ];
}

export function saveInsertedFragments(
  history: HistoryManager,
  fragments: Map<string, InsertedFragment>,
  include: (targetPath: string) => boolean = () => true,
): void {
  for (const [targetPath, fragment] of fragments) {
    if (!include(targetPath)) continue;
    history.saveInsertedFragment(
      targetPath,
      fragment.raw,
      fragment.processed,
      fragment.owned,
    );
  }
}

interface V0Capture {
  content?: Buffer;
  isSymlink: boolean;
}

const NO_V0: V0Capture = { isSymlink: false };

function isUnreadableSudo(diff: FileDiff, target: WriteTarget): boolean {
  return !!diff.isUnreadable && !diff.isNew && !!target.sudo;
}

// For a first-seen unreadable sudo file, capture v0 so
// revert-to-original works even when the invoking user cannot read
// the file directly. lstatFailed diffs are always isUnreadable too
// (until the stat-batch turns them into new-file diffs), so the
// pre-read batch covers both — no additional sudo calls needed.
// The idempotency pass already guarantees a preReads entry
// for every unreadable sudo target.
function captureV0(run: PullRun, i: number): V0Capture {
  const target = run.state.writeTargets[i];
  const diff = run.state.allDiffs[i];
  const firstSeenUnreadable =
    isUnreadableSudo(diff, target) &&
    !run.history.getFileMeta(target.targetPath);
  if (!firstSeenUnreadable) return NO_V0;
  const preRead = run.preReads.get(target.targetPath);
  if (!preRead) {
    // null = the sudo worker could not read the file (e.g. EACCES on
    // a root-owned parent directory). v0 cannot be captured, so
    // "avanti revert" will not restore this file to its pre-avanti
    // state. Warn so the user is aware.
    console.warn(
      `avanti: cannot capture original content of ${target.targetPath} — ` +
        `the file was unreadable by the privileged worker. ` +
        `"avanti revert" will not be able to restore it to its pre-avanti state.`,
    );
    return NO_V0;
  }
  const preReadBuf = Buffer.from(preRead.contentB64, 'base64');
  if (!preRead.isSymlink) return { content: preReadBuf, isSymlink: false };
  // Destination is a symlink and so is the write target — record
  // the existing link target as v0 for faithful revert/reset.
  if (target.symlinkTarget !== undefined) {
    return { content: preReadBuf, isSymlink: true };
  }
  // If the write target is a regular file but the destination is a
  // symlink, skip v0: reading through the symlink could capture
  // an unintended privileged file before write-path checks run.
  return NO_V0;
}

function stageTarget(
  run: PullRun,
  pullId: string,
  i: number,
  acceptedShaLabels: Set<string>,
): PullLogFileRef | undefined {
  const target = run.state.writeTargets[i];
  const diff = run.state.allDiffs[i];
  const acceptChanges = run.opts.acceptChanges ?? false;
  const records = run.state.sourceRecordsByTarget.get(target.targetPath);
  const isAccepted = (r: { matched: boolean; sourceLabel: string }): boolean =>
    !r.matched && acceptChanges && acceptedShaLabels.has(r.sourceLabel);
  const hasAcceptedSha = records?.some(isAccepted);
  if (!diff.hasChanges && !diff.isNew && !hasAcceptedSha) return undefined;
  try {
    const sourceShaRecords: SourceShaRecord[] | undefined = records?.map(
      (r) => ({
        label: r.sourceLabel,
        observedSha: r.observedSha,
        expectedSha: r.expectedSha,
        accepted: isAccepted(r),
      }),
    );
    const v0 = captureV0(run, i);
    const { fileRef } = run.history.stageFileVersion(
      pullId,
      target.targetPath,
      target.content,
      diff.isNew,
      {
        sources: sourceShaRecords,
        sudo: target.sudo,
        v0Override: v0.content,
        isSymlink: !!target.symlinkTarget,
        v0IsSymlinkOverride: v0.isSymlink,
      },
    );
    return fileRef;
  } catch {
    console.warn(`Warning: could not record history for ${target.targetPath}`);
    return undefined;
  }
}

/** Stage history versions before atomicWrite so v0 is captured before overwrite. */
export function stageHistory(run: PullRun): PullLogFileRef[] {
  const staged: PullLogFileRef[] = [];
  const { pullId } = run;
  if (!pullId) return staged;
  const acceptedShaLabels = new Set(
    run.state.shaErrors.map((e) => e.sourceLabel),
  );
  for (let i = 0; i < run.state.writeTargets.length; i++) {
    const ref = stageTarget(run, pullId, i, acceptedShaLabels);
    if (ref) staged.push(ref);
  }
  return staged;
}

/**
 * Records partial pull history for the files that landed on disk before a
 * write failure so `revert` can see them even though the pull did not
 * complete.
 */
export function recordPartialHistory(
  run: PullRun,
  pullId: string,
  writtenPaths: string[],
  stagedFileRefs: PullLogFileRef[],
  activeStaleRestore: { targetPath: string }[],
): void {
  const writtenSet = new Set(writtenPaths);
  const partialRefs = stagedFileRefs.filter((r) =>
    writtenSet.has(r.absolutePath),
  );
  // Stale restores also go through sudoAtomicWrite, so writtenPaths
  // may include paths from activeStaleRestore that are not in
  // stagedFileRefs. Track them so they can be excluded from lastFiles
  // (they are now restored to their pre-avanti state and no longer
  // tracked), and so the history update is not skipped when only
  // restores succeeded and partialRefs is empty.
  const restoredPaths = new Set(
    activeStaleRestore
      .map((t) => t.targetPath)
      .filter((p) => writtenSet.has(p)),
  );
  if (partialRefs.length > 0 || restoredPaths.size > 0) {
    try {
      run.history.closePullSession(
        pullId,
        normalizeConfigKey(run.configPath),
        mergeLastPullRefs(
          run.history.getLastPullFiles(),
          restoredPaths,
          partialRefs,
        ),
      );
    } catch {
      console.warn(
        'Warning: could not save partial pull history; avanti revert may not see the partially-written files.',
      );
    }
  }
  // Save the inserted fragments of files that landed, so the next
  // pull can remove what this one added. Files that did not land
  // keep their previous fragment.
  saveInsertedFragments(run.history, run.state.insertedFragments, (p) =>
    writtenSet.has(p),
  );
}

/**
 * Record to pulls.jsonl when files were staged OR stale files were
 * deleted/restored. For stale-only runs, merge surviving refs from the
 * last pull so the cleaned-up paths are no longer listed — without this,
 * subsequent pulls see the same stale files in the last-pull log and
 * attempt the same delete/restore again on every run.
 */
export function recordPullHistory(
  run: PullRun,
  stagedFileRefs: PullLogFileRef[],
  effectivelyCleaned: Set<string>,
): void {
  const { pullId } = run;
  if (!pullId) return;
  if (stagedFileRefs.length === 0 && effectivelyCleaned.size === 0) return;
  // pullId is only set when historyAvailable is true (see openPullSession),
  // so history storage is usable here.
  try {
    // Preserve existing sudo on surviving refs — these files were not
    // rewritten this pull, so their on-disk ownership reflects the
    // previous write identity. Replacing with the current config value
    // would let stale cleanup run with the wrong privileges.
    const refsToRecord = mergeLastPullRefs(
      run.history.getLastPullFiles(),
      effectivelyCleaned,
      stagedFileRefs,
    );
    run.history.closePullSession(
      pullId,
      normalizeConfigKey(run.configPath),
      refsToRecord,
    );
  } catch {
    console.warn('Warning: could not save pull history.');
  }
}
