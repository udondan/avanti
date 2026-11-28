/** write-symlink: stage a symlink at a temp path, then rename over the target. */
import * as fs from 'fs';
import * as path from 'path';
import { mkdirWithAncestorChecks } from './ancestors';
import {
  backupTarget,
  inspectExistingTarget,
  removeOrphanedBackup,
} from './backup';
import { randomHex, unlinkQuietly } from './fs-helpers';
import type { WriteSymlinkOp } from './types';

export function handleWriteSymlink(
  op: WriteSymlinkOp,
  trustedUids?: Set<number>,
): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  mkdirWithAncestorChecks(resolvedTarget, dir, trustedUids, 'destination');

  // Refuse to overwrite a real directory with a symlink. Store the lstat
  // result for reuse in the backup check below — eliminating a second syscall
  // and the TOCTOU window between the two stats.
  const existing = inspectExistingTarget(
    resolvedTarget,
    `symlink: ${op.targetPath} is a directory; refusing to replace it with a symlink`,
  );

  let backupCommitted = false;
  if (op.backupPath) {
    backupTarget({
      targetPath: resolvedTarget,
      backupPath: op.backupPath,
      lst: existing.lst,
      trustedUids,
      preobtainedLinkTarget: existing.linkTarget,
    });
    backupCommitted = true;
  }

  // Stage the new symlink at a temp path, then rename atomically.
  const tmpPath = path.join(dir, `.avanti-symlink-${randomHex()}`);
  try {
    fs.symlinkSync(op.symlinkTarget, tmpPath);

    fs.renameSync(tmpPath, resolvedTarget);
  } catch (err) {
    unlinkQuietly(tmpPath);
    // renameSync failed — the target was never modified. Remove the backup so
    // history does not record a change that never committed (mirrors handleWriteMv).
    // An orphaned backup is preferable to masking the real error.
    if (backupCommitted && op.backupPath) {
      removeOrphanedBackup(op.backupPath);
    }
    throw err;
  }
}
