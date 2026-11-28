/** Recovery after a failed write-in-place: restore content, mode and fds. */
import * as fs from 'fs';
import * as path from 'path';
import {
  closeQuietly,
  errnoCode,
  randomHex,
  safeFchmodSync,
  unlinkQuietly,
} from './fs-helpers';
import type { InPlaceContext, InPlaceState } from './in-place-state';

/**
 * Applies mode via the read fd when one is open (fd-based, no TOCTOU window),
 * otherwise via a path-based chmodSync.
 */
export function applyMode(
  resolvedTarget: string,
  rfd: number | undefined,
  mode: number,
): void {
  if (rfd !== undefined) {
    safeFchmodSync(rfd, mode);
  } else {
    fs.chmodSync(resolvedTarget, mode);
  }
}

export function applyModeQuietly(
  resolvedTarget: string,
  rfd: number | undefined,
  mode: number,
): void {
  try {
    applyMode(resolvedTarget, rfd, mode);
  } catch {
    // best-effort restore
  }
}

function restoreFromBackup(
  ctx: InPlaceContext,
  restoreTmp: string,
  backupPath: string,
): void {
  const { op, resolvedTarget } = ctx;
  // Rename-based restore to avoid following symlinks: stage backup content
  // to a temp file in the same dir as the target, then rename atomically.
  // copyFileSync alone would follow a symlink placed at resolvedTarget
  // between the truncation and the restore.
  try {
    // COPYFILE_EXCL uses O_CREAT|O_EXCL for the destination, so it fails
    // with EEXIST if a symlink was raced to restoreTmp before we write —
    // preventing the restore from following an attacker-controlled symlink
    // to overwrite an unrelated file.
    fs.copyFileSync(
      path.resolve(backupPath),
      restoreTmp,
      fs.constants.COPYFILE_EXCL,
    );
    fs.renameSync(restoreTmp, resolvedTarget);
  } catch (restoreErr) {
    unlinkQuietly(restoreTmp);
    if (errnoCode(restoreErr) === 'EISDIR') {
      // The parent directory was swapped for a symlink→directory between
      // the O_TRUNC and this restore rename. The file content is already
      // lost (truncated). Report clearly; backup copy is at op.backupPath.
      console.error(
        `avanti: write-in-place restore failed — ${op.targetPath} was replaced by a directory; file is truncated. Backup: ${op.backupPath}`,
      );
    } else {
      // Any other restore failure (ENOSPC, EACCES, etc.): surface it so
      // the user knows the file was left truncated.
      process.stderr.write(
        `avanti-worker: writeInPlace: restore of ${op.targetPath} from backup failed: ${(restoreErr as Error).message}\n`,
      );
    }
    // best-effort restore; original write error is re-thrown by the caller
  }
}

function restoreFromSnapshot(
  ctx: InPlaceContext,
  restoreTmp: string,
  snapshot: Buffer,
): void {
  // No backup: path configured. Use the pre-truncation in-memory snapshot
  // read via rfd before O_TRUNC zeroed the file. Uses the same
  // rename-based pattern as the backup restore above to avoid following
  // a symlink placed at resolvedTarget between the truncation and here.
  try {
    fs.writeFileSync(restoreTmp, snapshot, {
      flag: 'wx',
    });
    fs.renameSync(restoreTmp, ctx.resolvedTarget);
  } catch (restoreErr) {
    unlinkQuietly(restoreTmp);
    process.stderr.write(
      `avanti-worker: writeInPlace: in-memory restore of ${ctx.op.targetPath} failed: ${(restoreErr as Error).message}. File may be truncated.\n`,
    );
  }
}

function restoreTruncatedContent(
  ctx: InPlaceContext,
  state: InPlaceState,
): void {
  const restoreTmp = path.join(ctx.dir, `.avanti-restore-${randomHex()}`);
  if (ctx.op.backupPath) {
    restoreFromBackup(ctx, restoreTmp, ctx.op.backupPath);
  } else if (state.originalContentForRestore !== undefined) {
    restoreFromSnapshot(ctx, restoreTmp, state.originalContentForRestore);
  } else {
    // No backup path and no in-memory snapshot available (rfd was absent
    // because the read-open failed with EACCES, or the file exceeded
    // MAX_READ). The file was already truncated by O_TRUNC before the write
    // failed. No automatic recovery is possible.
    process.stderr.write(
      `avanti-worker: writeInPlace: ${ctx.op.targetPath} was truncated and no restore is possible (no backup: configured, no pre-read available). File may be permanently empty.\n`,
    );
  }
}

/** Undoes what it can after a failed overwrite, then closes both fds. */
export function recoverFailedWrite(
  ctx: InPlaceContext,
  state: InPlaceState,
): void {
  // Restore from backup ONLY when the content write itself failed (i.e.
  // O_TRUNC truncated the file but writeFileSync threw before finishing).
  // If writeSucceeded=true, only the subsequent fchmod failed — the new
  // content is already on disk and must NOT be overwritten with the old
  // backup (that would silently revert a successful write). The file will
  // have the correct content with potentially wrong permissions; the next
  // avanti pull will re-detect and re-apply the mode change.
  if (!state.writeSucceeded && state.fd !== undefined) {
    restoreTruncatedContent(ctx, state);
  }
  // Restore temporarily-boosted mode only when writeSucceeded is false.
  // If the write succeeded but the subsequent fchmod failed, the new content
  // is already on disk — restoring the old mode here would silently revert
  // the permission change. The next pull re-detects and re-applies the drift.
  // rfd is undefined when O_RDONLY failed with EACCES (write-only or
  // mode-0000 file owned by root; named-user has write but not read
  // access). Path-based chmodSync re-traverses the path string and
  // follows symlinks, so it has a narrow TOCTOU window: an attacker
  // controlling the parent directory could race a symlink between the
  // lstatSync check above and this call, causing chmodSync to affect an
  // unintended file. In the named-user scenario the invoking user already
  // controls the directory entry (it wrote there), so the window is
  // bounded in practice. A full fix would require fchmodat(2) with
  // AT_EMPTY_PATH on Linux — not exposed by Node.js without native code.
  if (!state.writeSucceeded && state.savedMode !== undefined) {
    applyModeQuietly(ctx.resolvedTarget, state.rfd, state.savedMode);
  }
  closeQuietly(state.fd);
  closeQuietly(state.rfd);
}
