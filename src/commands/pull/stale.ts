/** Detects files from the last pull that the current config no longer produces. */
import * as path from 'path';
import {
  buildNewFileDiff,
  buildNewSymlinkDiff,
  computeDeleteDiff,
  computeDiff,
  computeSymlinkDiff,
} from '../../diff';
import { HistoryManager } from '../../history';
import { WriteTarget } from '../../writer';
import { FetchLoopResult } from './fetch-loop';
import { StalePlan } from './types';

function emptyStalePlan(): StalePlan {
  return {
    toDelete: [],
    toRestore: [],
    diffs: [],
    restoreDiffIndices: [],
    hasError: false,
  };
}

function restoreSymlink(
  plan: StalePlan,
  absolutePath: string,
  original: Buffer,
  sudo: WriteTarget['sudo'],
): void {
  const symlinkTarget = original.toString('utf8');
  if (process.platform === 'win32') {
    console.error(
      `symlink: ${absolutePath}: cannot restore pre-avanti symlink on Windows`,
    );
    plan.hasError = true;
    // Show the actual stored target so the user knows what cannot
    // be restored. No restoreDiffIndices push — there is no
    // corresponding toRestore entry for error-only diffs.
    const warnDiff = buildNewSymlinkDiff(absolutePath, symlinkTarget);
    plan.diffs.push({ ...warnDiff, hasChanges: true });
    return;
  }
  const staleDiff = computeSymlinkDiff(absolutePath, symlinkTarget);
  if (staleDiff.isDirectory) {
    console.error(
      `symlink: ${absolutePath} is a directory; cannot restore symlink over directory`,
    );
    plan.hasError = true;
    // No restoreDiffIndices push — no corresponding
    // toRestore entry for this error-only diff.
    plan.diffs.push(staleDiff);
    return;
  }
  if (!staleDiff.hasChanges) return;
  plan.toRestore.push({
    targetPath: absolutePath,
    content: original,
    symlinkTarget,
    sudo,
  });
  plan.restoreDiffIndices.push(plan.diffs.length);
  plan.diffs.push(staleDiff);
}

function restoreFile(
  plan: StalePlan,
  absolutePath: string,
  original: Buffer,
  sudo: WriteTarget['sudo'],
): void {
  plan.toRestore.push({ targetPath: absolutePath, content: original, sudo });
  plan.restoreDiffIndices.push(plan.diffs.length);
  const staleDiff = computeDiff(absolutePath, original);
  // A missing file with empty v0 produces isNew=true but
  // hasChanges=false and an empty patch, so formatDiff returns ''.
  // Rebuild as a proper new-file diff so the confirmation output
  // shows the recreate action and the patch is consistent.
  plan.diffs.push(
    staleDiff.isNew ? buildNewFileDiff(absolutePath, original) : staleDiff,
  );
}

function planDelete(
  plan: StalePlan,
  absolutePath: string,
  sudo: WriteTarget['sudo'],
): void {
  plan.toDelete.push({
    path: absolutePath,
    sudo: sudo || undefined,
    diffIndex: plan.diffs.length,
  });
  plan.diffs.push(computeDeleteDiff(absolutePath));
}

function planStaleFile(
  plan: StalePlan,
  history: HistoryManager,
  absolutePath: string,
): void {
  const meta = history.getFileMeta(absolutePath);
  if (!meta) return;
  if (!meta.existedBeforeAvanti) {
    planDelete(plan, absolutePath, meta.sudo);
    return;
  }
  const original = history.readVersion(absolutePath, 0);
  if (original === null) {
    console.warn(
      `Warning: cannot restore original for ${absolutePath} — v0 was never captured (file was unreadable at first pull). Leaving file unchanged.`,
    );
    return;
  }
  if (meta.v0IsSymlink) {
    restoreSymlink(plan, absolutePath, original, meta.sudo);
  } else {
    restoreFile(plan, absolutePath, original, meta.sudo);
  }
}

/** Detect stale files: present in last pull but no longer in current source fetch. */
export function detectStale(
  history: HistoryManager,
  historyAvailable: boolean,
  state: FetchLoopResult,
): StalePlan {
  const plan = emptyStalePlan();
  if (!historyAvailable || state.hasUnresolvableSkippedPath) return plan;
  const lastFiles = history.getLastPullFiles();
  const currentPaths = new Set(state.writeTargets.map((t) => t.targetPath));
  const skippedPathsArr = [...state.skippedPaths];
  for (const ref of lastFiles) {
    if (currentPaths.has(ref.absolutePath)) continue;
    // Files covered by a skipped (condition-gated) entry should not be
    // treated as stale — the entry is still in the config, it just didn't
    // run this time. Exact match for file entries; prefix match for
    // directory entries (whose resolved base path is the directory itself).
    const coveredBySkipped = skippedPathsArr.some(
      (sp) =>
        ref.absolutePath === sp || ref.absolutePath.startsWith(sp + path.sep),
    );
    if (coveredBySkipped) continue;
    planStaleFile(plan, history, ref.absolutePath);
  }
  return plan;
}
