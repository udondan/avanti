/**
 * Pre-reads unreadable sudo targets through the privileged worker for
 * idempotency (skip writes whose content already matches) and v0 capture.
 */
import { closeAllSessions, sudoAtomicRead } from '../../writer';
import { abortWithSessions } from './sudo-sessions';
import { FileHookContext, PullRun } from './types';

interface PreReadRequest {
  filePath: string;
  sudo: true | string;
  type: 'stat-read';
}

function preReadRequests(run: PullRun): PreReadRequest[] {
  const { writeTargets, allDiffs } = run.state;
  const stale = run.stale;
  const requests: PreReadRequest[] = [];
  writeTargets.forEach((t, i) => {
    if (allDiffs[i].isUnreadable && t.sudo) {
      requests.push({
        filePath: t.targetPath,
        sudo: t.sudo,
        type: 'stat-read',
      });
    }
  });
  stale.toRestore.forEach((t, i) => {
    const diffIdx = stale.restoreDiffIndices[i];
    if (stale.diffs[diffIdx]?.isUnreadable && t.sudo) {
      requests.push({
        filePath: t.targetPath,
        sudo: t.sudo,
        type: 'stat-read',
      });
    }
  });
  return requests;
}

function removeHookContext(
  contexts: FileHookContext[],
  targetPath: string,
): void {
  const hookIdx = contexts.findIndex((ctx) => ctx.targetPath === targetPath);
  if (hookIdx >= 0) {
    contexts.splice(hookIdx, 1);
  }
}

function missingPreRead(run: PullRun, what: string, targetPath: string): never {
  closeAllSessions(run.sessions);
  throw new Error(
    `internal: missing pre-read result for ${what} ${targetPath}`,
  );
}

function checkWriteTarget(run: PullRun, i: number): void {
  const { writeTargets, allDiffs, fileHookContexts } = run.state;
  const target = writeTargets[i];
  if (!allDiffs[i].isUnreadable || !target.sudo) return;
  const preRead = run.preReads.get(target.targetPath);
  if (preRead === undefined) {
    missingPreRead(run, 'sudo target', target.targetPath);
  }
  if (preRead === null) return;
  const preReadBuf = Buffer.from(preRead.contentB64, 'base64');

  if (target.symlinkTarget !== undefined) {
    if (preRead.isSymlink && preReadBuf.toString() === target.symlinkTarget) {
      // Symlink targets carry no mode, so there is no mode drift left.
      allDiffs[i] = {
        ...allDiffs[i],
        contentChanged: false,
        hasChanges: false,
      };
      removeHookContext(fileHookContexts, target.targetPath);
    }
    return;
  }
  if (preRead.isSymlink) return;
  if (!preReadBuf.equals(target.content)) return;
  const updatedHasChanges = allDiffs[i].modeChange !== undefined;
  allDiffs[i] = {
    ...allDiffs[i],
    contentChanged: false,
    hasChanges: updatedHasChanges,
  };
  if (!updatedHasChanges) {
    removeHookContext(fileHookContexts, target.targetPath);
  }
}

function checkStaleRestore(run: PullRun, i: number): void {
  const stale = run.stale;
  const diffIdx = stale.restoreDiffIndices[i];
  const entry = stale.toRestore[i];
  if (!stale.diffs[diffIdx]?.isUnreadable || !entry.sudo) return;
  const preRead = run.preReads.get(entry.targetPath);
  if (preRead === undefined) {
    missingPreRead(run, 'sudo stale-restore target', entry.targetPath);
  }
  if (preRead === null || preRead.isSymlink) return;
  const current = Buffer.from(preRead.contentB64, 'base64');
  if (current.equals(entry.content)) {
    stale.diffs[diffIdx] = {
      ...stale.diffs[diffIdx],
      contentChanged: false,
      hasChanges: stale.diffs[diffIdx].modeChange !== undefined,
    };
  }
}

/**
 * Pre-reads for unreadable sudo targets, then idempotency: compare current
 * file content via sudo against the desired content and suppress the write
 * when they already match.
 */
export async function checkUnreadableTargets(run: PullRun): Promise<void> {
  const requests = preReadRequests(run);
  if (requests.length > 0) {
    try {
      run.preReads = await sudoAtomicRead(requests, run.sessions);
    } catch (err) {
      abortWithSessions(run, 'Read failed: ', err);
    }
  }
  for (let i = 0; i < run.state.writeTargets.length; i++) {
    checkWriteTarget(run, i);
  }
  for (let i = 0; i < run.stale.toRestore.length; i++) {
    checkStaleRestore(run, i);
  }
}
