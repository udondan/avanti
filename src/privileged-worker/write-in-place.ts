/** write-in-place: overwrite the target's inode, keeping owner and links. */
import * as fs from 'fs';
import * as path from 'path';
import { mkdirWithAncestorChecks } from './ancestors';
import { backupRegularFile } from './backup';
import {
  MAX_READ,
  O_NOFOLLOW,
  O_NONBLOCK,
  closeQuietly,
  errnoCode,
  parseMode,
  safeFchmodSync,
  unlinkQuietly,
  validateBase64,
} from './fs-helpers';
import { openForTruncatingWrite } from './in-place-open';
import { recoverFailedWrite } from './in-place-restore';
import type { InPlaceContext, InPlaceState } from './in-place-state';
import { notRegularFileRefusal, symlinkRefusal } from './in-place-state';
import type { WriteInPlaceOp } from './types';

// Refuse symlinks (would follow to unintended target).
// Refuse non-regular files (FIFOs, devices, sockets).
// Returns true when the target does not exist yet.
function isNewTarget(op: WriteInPlaceOp, resolvedTarget: string): boolean {
  try {
    const lst = fs.lstatSync(resolvedTarget);
    if (lst.isSymbolicLink()) {
      throw symlinkRefusal(op.targetPath);
    }
    if (!lst.isFile()) {
      throw notRegularFileRefusal(op.targetPath);
    }
    return false;
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return true;
    throw e;
  }
}

function writeNewFile(
  resolvedTarget: string,
  content: Buffer,
  effectiveMode: string | undefined,
): void {
  // O_EXCL (the 'x' flag) ensures atomic creation — no symlink can exist at
  // the path at open time, so following is impossible by construction. Keep
  // the fd open and write through it (no path-based TOCTOU after open).
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolvedTarget, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    if (effectiveMode !== undefined) {
      safeFchmodSync(fd, parseMode(effectiveMode));
    }
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    closeQuietly(fd);
    // The file was created (O_EXCL) but the write or chmod failed, leaving
    // a 0-byte stub. Remove it so the path does not appear to exist on the
    // next avanti pull (where it would be treated as an existing file and
    // take the write-in-place path instead of the new-file path).
    // Best-effort; the empty file is benign but avanti pull will overwrite it.
    unlinkQuietly(resolvedTarget);
    throw err;
  }
}

// Captures mode (and size) via the read fd. Opening read-only first
// (O_NOFOLLOW|O_NONBLOCK) verifies the file is still a regular file (not a
// symlink/FIFO) and captures the current mode including setuid/setgid bits
// BEFORE the O_TRUNC write-open clears them on Linux.
function captureViaReadFd(ctx: InPlaceContext, state: InPlaceState): number {
  const rfd = fs.openSync(
    ctx.resolvedTarget,
    fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
  );
  state.rfd = rfd;
  const rst = fs.fstatSync(rfd);
  if (!rst.isFile()) {
    throw notRegularFileRefusal(ctx.op.targetPath);
  }
  const savedMode = rst.mode & 0o7777;
  state.savedMode = savedMode;
  state.savedSize = rst.size;
  return savedMode;
}

function captureOriginal(ctx: InPlaceContext, state: InPlaceState): number {
  try {
    return captureViaReadFd(ctx, state);
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ELOOP') {
      // TOCTOU: a symlink was placed at the path after the lstatSync check
      // above but before O_NOFOLLOW openSync. Surface a clear error.
      throw symlinkRefusal(ctx.op.targetPath, { cause: e });
    }
    if (code !== 'EACCES') throw e;
    // Write-only file (e.g. mode 0200): O_RDONLY fails with EACCES.
    // Fall back to a path-based stat to capture the mode; the write open
    // below will succeed directly so no rfd-based EACCES recovery is needed.
    // Use lstatSync (not statSync) to avoid following symlinks — the caller
    // already verified the path is a regular file via lstatSync above.
    const rst = fs.lstatSync(ctx.resolvedTarget);
    if (!rst.isFile()) {
      throw notRegularFileRefusal(ctx.op.targetPath, { cause: e });
    }
    const savedMode = rst.mode & 0o7777;
    state.savedMode = savedMode;
    // rfd stays undefined — no EACCES recovery fchmod needed.
    return savedMode;
  }
}

// Read original content for in-memory restore when no backup: is configured.
// Must happen before the O_TRUNC write-open (which zeroes the file).
// Only when rfd is available (EACCES path has no rfd) and within MAX_READ.
// If the file is larger than MAX_READ without a backup path, there is no
// safe restore on write failure — see recoverFailedWrite.
function snapshotForRestore(ctx: InPlaceContext, state: InPlaceState): void {
  if (ctx.op.backupPath) return;
  const { rfd, savedSize } = state;
  if (rfd === undefined || savedSize === undefined || savedSize > MAX_READ) {
    return;
  }
  state.originalContentForRestore = Buffer.alloc(savedSize);
  if (savedSize > 0) {
    fs.readSync(rfd, state.originalContentForRestore, 0, savedSize, 0);
  }
}

// fchmod only when needed: apply explicit mode, or restore setuid/setgid
// bits that Linux strips on O_TRUNC. Skip when neither applies — a named
// user writing via group permission may not own the file and fchmod would
// fail with EPERM even though the write succeeded.
function finalMode(
  effectiveMode: string | undefined,
  savedMode: number,
): number | undefined {
  if (effectiveMode !== undefined) return parseMode(effectiveMode);
  if ((savedMode & 0o7000) !== 0) return savedMode;
  return undefined;
}

function writeContent(
  ctx: InPlaceContext,
  state: InPlaceState,
  fd: number,
  savedMode: number,
): void {
  // fstat after the write-open as a belt-and-suspenders check: a FIFO
  // or other non-regular file could have been substituted in the window
  // between the rfd open and fd open.
  const fst = fs.fstatSync(fd);
  if (!fst.isFile()) {
    throw new Error(
      `writeInPlace: ${ctx.op.targetPath} is not a regular file after open; refusing to write`,
    );
  }
  fs.writeFileSync(fd, ctx.content);
  state.writeSucceeded = true;
  const mode = finalMode(ctx.effectiveMode, savedMode);
  if (mode !== undefined) {
    safeFchmodSync(fd, mode);
  }
  fs.closeSync(fd);
  state.fd = undefined;
  if (state.rfd !== undefined) {
    fs.closeSync(state.rfd);
    state.rfd = undefined;
  }
}

// Opens read-only first to capture the mode, then opens for writing. If the
// write-open fails with EACCES (named-user sudo running as a non-root uid),
// fchmod via the read fd to temporarily add a write bit, retry, then always
// restore the original mode.
function overwriteExistingFile(ctx: InPlaceContext): void {
  const state: InPlaceState = { writeSucceeded: false };
  try {
    const savedMode = captureOriginal(ctx, state);
    snapshotForRestore(ctx, state);
    const fd = openForTruncatingWrite(ctx, state, savedMode);
    writeContent(ctx, state, fd, savedMode);
  } catch (err) {
    recoverFailedWrite(ctx, state);
    throw err;
  }
}

export function handleWriteInPlace(
  op: WriteInPlaceOp,
  trustedUids?: Set<number>,
): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  mkdirWithAncestorChecks(resolvedTarget, dir, trustedUids, 'destination');

  // Check BEFORE the backup so that a race turning the target into a symlink
  // between these checks does not leave an orphaned backup without a write.
  // backupRegularFile also uses O_NOFOLLOW and handles ELOOP internally, so
  // the residual window between here and the backup call is self-contained.
  const isNewFile = isNewTarget(op, resolvedTarget);

  // Validate and decode content before committing the backup. If contentB64 is
  // invalid, the write would fail anyway — but without this ordering the backup
  // would already be committed, leaving an orphaned copy at backupPath with no
  // new file written. Validating first means a bad base64 payload is caught
  // before any filesystem state changes (matching handleWriteMv's ordering).
  validateBase64(op.contentB64, 'contentB64');
  const content = Buffer.from(op.contentB64, 'base64');

  // Commit the backup AFTER confirming the target is still a regular file and
  // validating contentB64. backupRegularFile internally stages to an O_EXCL temp
  // and renames atomically, so no outer try/catch wrapper is needed here.
  if (op.backupPath && !isNewFile) {
    backupRegularFile(resolvedTarget, path.resolve(op.backupPath), trustedUids);
  }

  if (isNewFile) {
    writeNewFile(resolvedTarget, content, op.mode ?? op.defaultMode);
  } else {
    overwriteExistingFile({
      op,
      resolvedTarget,
      dir,
      content,
      effectiveMode: op.mode,
    });
  }
}
