/** write-mv: stage to an O_EXCL temp file, then rename over the target. */
import * as fs from 'fs';
import * as path from 'path';
import { mkdirWithAncestorChecks } from './ancestors';
import {
  backupTarget,
  inspectExistingTarget,
  removeOrphanedBackup,
} from './backup';
import {
  closeQuietly,
  getExistingMode,
  parseMode,
  randomHex,
  safeFchmodSync,
  unlinkQuietly,
  validateBase64,
} from './fs-helpers';
import type { WriteMvOp } from './types';

interface MvState {
  tfd?: number;
  backupCommitted: boolean;
}

function writeTempFile(
  op: WriteMvOp,
  tmpPath: string,
  existingMode: string | undefined,
  state: MvState,
): void {
  const tfd = fs.openSync(tmpPath, 'wx', 0o600);
  state.tfd = tfd;
  validateBase64(op.contentB64, 'contentB64');
  fs.writeFileSync(tfd, Buffer.from(op.contentB64, 'base64'));

  const effectiveMode = op.mode ?? existingMode ?? op.defaultMode;
  safeFchmodSync(tfd, parseMode(effectiveMode));
  fs.closeSync(tfd);
  state.tfd = undefined;
}

function commitMv(
  op: WriteMvOp,
  resolvedTarget: string,
  tmpPath: string,
  state: MvState,
  trustedUids: Set<number> | undefined,
): void {
  // rename(2) is atomic and never follows symlinks on any POSIX platform.
  // Refuse real directories (rename(2) would fail with EISDIR anyway, but
  // this gives a cleaner error message). Symlinks-to-directories are fine —
  // rename(2) replaces the symlink itself, not its target.
  // Capture lst here for reuse in the backup step below.
  const existing = inspectExistingTarget(
    resolvedTarget,
    `target path is a directory: ${op.targetPath}`,
  );

  // Backup AFTER staging succeeds: a staging failure no longer leaves a
  // backup behind without the new file being committed.
  // Use backupTarget (not backupRegularFile) so that a symlink at the target
  // is backed up as a symlink rather than silently skipped.
  if (op.backupPath) {
    backupTarget({
      targetPath: resolvedTarget,
      backupPath: op.backupPath,
      lst: existing.lst,
      trustedUids,
      preobtainedLinkTarget: existing.linkTarget,
    });
    state.backupCommitted = true;
  }

  fs.renameSync(tmpPath, resolvedTarget);
}

export function handleWriteMv(op: WriteMvOp, trustedUids?: Set<number>): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  // The dispatch loop already ran checkAncestorsSafeAsRoot before calling this
  // handler; the pre-mkdirSync call below is intentionally redundant (belt-and-
  // suspenders) for callers that invoke handlers directly in tests or future
  // code paths. The post-mkdirSync call is essential to validate any new
  // intermediate directories that mkdirSync itself creates.
  mkdirWithAncestorChecks(resolvedTarget, dir, trustedUids, 'destination');

  const existingMode = op.mode ? undefined : getExistingMode(resolvedTarget);

  // O_EXCL temp in destination directory. Keep the fd open and write through
  // it so no path-based TOCTOU window opens between open and write.
  const tmpPath = path.join(dir, `.avanti-${randomHex()}`);
  const state: MvState = { backupCommitted: false };
  try {
    writeTempFile(op, tmpPath, existingMode, state);
    commitMv(op, resolvedTarget, tmpPath, state, trustedUids);
  } catch (err) {
    closeQuietly(state.tfd);
    unlinkQuietly(tmpPath);
    // If the backup was committed but the write rename failed, remove the
    // orphaned backup — the original is still intact at resolvedTarget.
    if (state.backupCommitted && op.backupPath) {
      removeOrphanedBackup(op.backupPath);
    }
    throw err;
  }
}
