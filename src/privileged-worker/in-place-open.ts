/** write-in-place: open the existing target for a truncating write. */
import * as fs from 'fs';
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  closeQuietly,
  errnoCode,
  safeFchmodSync,
} from './fs-helpers';
import type { InPlaceContext, InPlaceState } from './in-place-state';
import { symlinkRefusal } from './in-place-state';
import { applyMode, applyModeQuietly } from './in-place-restore';

// O_NONBLOCK omitted: rfd + fstatSync already verified the target is
// a regular file. O_NONBLOCK on a regular-file write fd can return EAGAIN
// on NFS/FUSE, which fs.writeFileSync does not handle.
function truncatingWriteFlags(): number {
  return fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW;
}

// Named-user sudo (running as a non-root uid) may lack write permission on
// the file; temporarily adding the write bit is then the recovery path.
function canGrantWriteBit(openErr: NodeJS.ErrnoException): boolean {
  return (
    openErr.code === 'EACCES' &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
  );
}

// rfd is undefined: O_RDONLY|O_NOFOLLOW failed with EACCES (write-only
// or no-permission file). Try to acquire a write-only fd without following
// symlinks so fchmod can go through the fd (no TOCTOU window).
function openWriteOnlyFd(ctx: InPlaceContext): number | undefined {
  try {
    return fs.openSync(
      ctx.resolvedTarget,
      fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
    );
  } catch (e2) {
    if (errnoCode(e2) === 'ELOOP') {
      // A symlink was raced in after lstatSync confirmed a regular file.
      throw symlinkRefusal(ctx.op.targetPath, { cause: e2 });
    }
    // EACCES: mode 0000 or no write bit — fd-based fchmod not possible;
    // fall through to path-based chmodSync (residual TOCTOU window).
    return undefined;
  }
}

function grantWriteBitViaWriteFd(
  ctx: InPlaceContext,
  openErr: NodeJS.ErrnoException,
  mode: number,
): void {
  const wfd = openWriteOnlyFd(ctx);
  if (wfd === undefined) {
    // Neither fd-based nor path-based chmod is safe here: O_RDONLY and
    // O_WRONLY both failed with EACCES (mode-0000 or SELinux/AppArmor MAC
    // policy). Path-based chmodSync would require two sequential path
    // traversals (add write bit, then restore) with a TOCTOU window between
    // them that a racing attacker can exploit to permanently widen permissions
    // on an unintended root-owned file. Refuse rather than proceed with a
    // known-racy operation.
    throw new Error(
      `writeInPlace: ${ctx.op.targetPath} is not writable (mode ${mode.toString(8)}) and no fd-based chmod path is available; ` +
        `chmod the file to at least 0200 first or use write-mv instead`,
    );
  }
  try {
    safeFchmodSync(wfd, mode | 0o200);
  } catch {
    throw openErr;
  } finally {
    closeQuietly(wfd);
  }
}

// Temporarily adds the write bit so we can open the file for writing.
// Prefer fd-based fchmod (via rfd) when available to avoid a path-based
// TOCTOU window.
function grantWriteBit(
  ctx: InPlaceContext,
  rfd: number | undefined,
  openErr: NodeJS.ErrnoException,
  mode: number,
): void {
  if (rfd === undefined) {
    grantWriteBitViaWriteFd(ctx, openErr, mode);
    return;
  }
  // fd-based path: no TOCTOU window between stat and chmod.
  try {
    safeFchmodSync(rfd, mode | 0o200);
  } catch {
    throw openErr;
  }
}

function openWithTemporaryWriteBit(
  ctx: InPlaceContext,
  state: InPlaceState,
  openErr: NodeJS.ErrnoException,
  mode: number,
): number {
  // Named-user sudo: temporarily add the write bit so we can open the
  // file for writing. savedMode (mode) is always defined at this point: if
  // the O_RDONLY open succeeded, fstatSync set it; if not, lstatSync set it
  // (and any other failure re-threw rather than reaching here).
  grantWriteBit(ctx, state.rfd, openErr, mode);
  let fd: number;
  try {
    fd = fs.openSync(ctx.resolvedTarget, truncatingWriteFlags());
  } catch (retryErr) {
    // Restore original mode before surfacing the error.
    applyModeQuietly(ctx.resolvedTarget, state.rfd, mode);
    throw retryErr;
  }
  // Set before the mode restore below: the file is already truncated, so a
  // restore failure must trigger the content recovery.
  state.fd = fd;
  // Restore original mode immediately after the write-open succeeds —
  // the write bit was temporary. The conditional fchmod after the write
  // handles explicit mode and setuid/setgid bits via fd; this restore
  // covers the case where neither applies (e.g. a plain 0o400 file).
  // With rfd the fchmod operates on the already-open inode, not on the
  // path string, so no TOCTOU window. Without rfd (O_RDONLY failed with
  // EACCES: write-only file owned by root; the invoking user has write but
  // not read access) the path-based chmodSync re-traverses the path string
  // and follows symlinks, so it has a narrow TOCTOU window: an attacker
  // controlling the parent directory could race a symlink between the
  // earlier lstatSync and this call, causing chmodSync to operate on an
  // unintended file. A full fix would require fchmodat(2) with
  // AT_EMPTY_PATH on Linux — not exposed by Node.js without native code.
  // The same window exists in the failure recovery (where rfd is also
  // undefined).
  try {
    applyMode(ctx.resolvedTarget, state.rfd, mode);
  } catch (restoreErr) {
    throw new Error(
      `writeInPlace: failed to restore mode on ${ctx.op.targetPath} after temporary write-bit grant: ${(restoreErr as Error).message}`,
      { cause: restoreErr },
    );
  }
  return fd;
}

/**
 * Opens the target O_WRONLY|O_TRUNC into state.fd. If that fails with EACCES
 * for a named (non-root) sudo user, temporarily grants the write bit, retries,
 * then restores the original mode.
 */
export function openForTruncatingWrite(
  ctx: InPlaceContext,
  state: InPlaceState,
  savedMode: number,
): number {
  // Capture the initial write-open error so the EACCES recovery runs
  // outside the catch block, avoiding the preserve-caught-error lint constraint.
  let firstOpenErr: NodeJS.ErrnoException;
  try {
    const fd = fs.openSync(ctx.resolvedTarget, truncatingWriteFlags());
    state.fd = fd;
    return fd;
  } catch (e) {
    firstOpenErr = e as NodeJS.ErrnoException;
  }
  if (!canGrantWriteBit(firstOpenErr)) throw firstOpenErr;
  return openWithTemporaryWriteBit(ctx, state, firstOpenErr, savedMode);
}
