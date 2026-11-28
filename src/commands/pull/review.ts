/** Shows the pull diff and asks the user to confirm it. */
import { normalizeConfigKey } from '../../config';
import { FileDiff, printDiffs } from '../../diff';
import { closeAllSessions } from '../../writer';
import { confirm } from '../../prompt';
import { mergeLastPullRefs, saveInsertedFragments } from './history-record';
import { printShaErrors } from './sha';
import { PullRun } from './types';

/** True when a diff still needs work (write, create, or a privileged check). */
export function isPendingDiff(d: FileDiff): boolean {
  if (d.hasChanges || d.isNew) return true;
  return !!(d.lstatFailed || d.isUnreadable);
}

/** Windows does not have sudo; fail before any authentication attempt. */
export function assertNoSudoOnWindows(run: PullRun): void {
  if (process.platform !== 'win32') return;
  const candidates = [
    ...run.state.writeTargets,
    ...run.stale.toRestore,
    ...run.stale.toDelete,
  ];
  if (candidates.some((t) => t.sudo)) {
    console.error('sudo is not supported on Windows');
    process.exit(2);
  }
}

function hasStaleEntries(run: PullRun): boolean {
  return run.stale.toDelete.length > 0 || run.stale.toRestore.length > 0;
}

/**
 * Prune no-op stale refs from the pull log. When all diffs are clean,
 * every stale entry (delete or restore) was already resolved outside of
 * avanti (file manually deleted, or content already matches v0). Without
 * this, those refs remain in the last-pull log and can incorrectly flag
 * a future file at the same path as stale.
 */
function pruneNoopStaleRefs(run: PullRun): void {
  const { pullId, history, stale } = run;
  if (!pullId || !run.historyAvailable || !hasStaleEntries(run)) return;
  const noopStalePaths = new Set<string>([
    ...stale.toDelete.map((d) => d.path),
    ...stale.toRestore.map((t) => t.targetPath),
  ]);
  // Preserve existing sudo on surviving refs — no file was written, so
  // the on-disk ownership reflects the previous write identity, not the
  // current config. Overwriting here would let stale cleanup run with
  // the wrong privileges for a file it never re-wrote.
  history.closePullSession(
    pullId,
    normalizeConfigKey(run.configPath),
    mergeLastPullRefs(history.getLastPullFiles(), noopStalePaths, []),
  );
}

function finishWithoutChanges(run: PullRun): never {
  if (run.historyAvailable && run.state.insertedFragments.size > 0) {
    saveInsertedFragments(run.history, run.state.insertedFragments);
  }
  pruneNoopStaleRefs(run);
  closeAllSessions(run.sessions);
  console.log('Nothing to do.');
  process.exit(0);
}

async function confirmApply(run: PullRun): Promise<void> {
  const acceptingShas =
    run.opts.acceptChanges && run.state.shaErrors.length > 0;
  const promptMsg = acceptingShas
    ? 'Accept new SHA values and apply changes? [y/N] '
    : 'Apply changes? [y/N] ';
  let ok: boolean;
  try {
    ok = await confirm(promptMsg);
  } catch (err) {
    closeAllSessions(run.sessions);
    throw err;
  }
  if (!ok) {
    closeAllSessions(run.sessions);
    console.log('Aborted.');
    process.exit(0);
  }
}

/** Prints the diff, exits when there is nothing to do, and prompts unless --yes. */
export async function reviewChanges(run: PullRun): Promise<void> {
  const { allDiffs } = run.state;
  const { diffs: staleDiffs } = run.stale;
  const shaErrors = run.state.shaErrors;
  const hasChanges =
    allDiffs.some(isPendingDiff) || staleDiffs.some(isPendingDiff);
  printDiffs([...allDiffs, ...staleDiffs]);

  if (run.stale.hasError) {
    closeAllSessions(run.sessions);
    process.exit(2);
  }

  // Show SHA mismatch summary when using --accept-changes
  if (run.opts.acceptChanges && shaErrors.length > 0) {
    console.error('');
    printShaErrors(shaErrors);
  }

  if (!hasChanges && shaErrors.length === 0) finishWithoutChanges(run);

  const yes: boolean = run.opts.yes ?? false;
  if (!yes) await confirmApply(run);
}
