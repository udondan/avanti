/** Opens privileged worker sessions for the sudo identities a pull needs. */
import { FileDiff } from '../../diff';
import { closeAllSessions, openPrivilegedSessions } from '../../writer';
import { errorMessage } from './common';
import { isPendingDiff } from './review';
import { PullRun } from './types';

/** Closes all sessions, prints `prefix + message` and exits with code 2. */
export function abortWithSessions(
  run: PullRun,
  prefix: string,
  err: unknown,
): never {
  closeAllSessions(run.sessions);
  console.error(`${prefix}${errorMessage(err)}`);
  process.exit(2);
}

/** Mode-only change: content already matches, only permissions drifted. */
function isModeOnly(d: FileDiff): boolean {
  return !!d.modeChange && !d.contentChanged;
}

function collectSudoIds(run: PullRun): Set<true | string> {
  const { writeTargets, allDiffs } = run.state;
  const stale = run.stale;
  const sudoIds = new Set<true | string>();
  writeTargets.forEach((t, i) => {
    if (t.sudo && isPendingDiff(allDiffs[i])) sudoIds.add(t.sudo);
  });
  stale.toRestore.forEach((t, i) => {
    const d = stale.diffs[stale.restoreDiffIndices[i]];
    if (t.sudo && isPendingDiff(d)) sudoIds.add(t.sudo);
  });
  // Mode-only sudo targets (content already matches, only permissions
  // drifted): hasChanges=true but contentChanged=false. Include them so
  // sudoAtomicWrite shares the same session as content writes.
  writeTargets.forEach((t, i) => {
    if (t.sudo && isModeOnly(allDiffs[i])) sudoIds.add(t.sudo);
  });
  // Delete-only identities — only when the stale file still exists.
  for (const d of stale.toDelete) {
    if (d.sudo && stale.diffs[d.diffIndex].hasChanges) sudoIds.add(d.sudo);
  }
  return sudoIds;
}

/**
 * Open one persistent sudo worker session per distinct sudo identity,
 * after the user has confirmed. All sudo operations (stat-reads, pre-reads,
 * idempotency checks, and writes) share these sessions so the password
 * prompt appears at most once per identity, after the diff is reviewed.
 */
export function openSudoSessions(run: PullRun): void {
  // No platform guard: sudo is rejected on Windows before this point, and
  // openPrivilegedSessions returns an empty map there.
  const sudoIds = collectSudoIds(run);
  try {
    for (const [id, session] of openPrivilegedSessions(sudoIds))
      run.sessions.set(id, session);
  } catch (err) {
    abortWithSessions(run, '', err);
  }
}
