/** atomicWrite phase 4: in-place writes that preserve the destination inode. */
import * as fs from 'fs';
import * as path from 'path';
import { parseMode } from '../privileged-worker';
import { ensureDir, openFlag, writeAll } from './fs-utils';
import type { WriteTarget } from './types';

function notRegularFile(targetPath: string): Error {
  return new Error(
    `writeInPlace: ${targetPath} is not a regular file; refusing to write`,
  );
}

function symlinkRefused(targetPath: string, cause?: unknown): Error {
  const message = `writeInPlace: ${targetPath} is a symlink; refusing to follow`;
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}

// Phase 4: in-place write — preserve inode, not atomic. Pushes t.targetPath
// onto writtenPaths as soon as its content is committed.
export function writeInPlace(t: WriteTarget, writtenPaths: string[]): void {
  ensureDir(path.dirname(t.targetPath));
  const existingEntry = fs.lstatSync(t.targetPath, {
    throwIfNoEntry: false,
  });
  // Fast-path rejection of non-regular, non-symlink entries (FIFOs,
  // sockets, devices): opening a FIFO with O_WRONLY blocks until a reader
  // connects; device/socket writes have unpredictable side effects. Not
  // relied on for correctness — the fstat check on the opened fd (below,
  // POSIX path) closes the TOCTOU window if the path is replaced after
  // this check.
  if (
    existingEntry &&
    !existingEntry.isFile() &&
    !existingEntry.isSymbolicLink()
  ) {
    throw notRegularFile(t.targetPath);
  }
  let effectiveMode: number | undefined;
  if (t.mode) {
    effectiveMode = parseMode(t.mode);
  } else if (existingEntry?.isFile()) {
    effectiveMode = existingEntry.mode & 0o7777;
  }
  // Refuse to follow a symlink — unlike renameSync, which replaces the
  // symlink itself, writeFileSync would write through it to the target.
  // On POSIX: open with O_NOFOLLOW so the kernel rejects symlinks
  // atomically (no TOCTOU window); ELOOP means the path is a symlink.
  // O_NONBLOCK prevents blocking at open(2) if the lstatSync pre-check
  // lost a TOCTOU race and the path became a FIFO with no reader.
  // fstatSync on the opened fd then closes the remaining TOCTOU window by
  // validating the type after open, before any write.
  // On Windows: O_NOFOLLOW is not available; fall back to an lstat check
  // (best-effort — a narrow TOCTOU race remains).
  const oNoFollow = openFlag('O_NOFOLLOW');
  const oNonBlock = openFlag('O_NONBLOCK');
  if (oNoFollow !== 0) {
    writeNoFollow(t, effectiveMode, oNoFollow | oNonBlock, writtenPaths);
  } else {
    writeWithoutNoFollow(t, existingEntry, effectiveMode, writtenPaths);
  }
}

// POSIX path: the mode is applied via fchmodSync on the open fd.
function writeNoFollow(
  t: WriteTarget,
  effectiveMode: number | undefined,
  extraFlags: number,
  writtenPaths: string[],
): void {
  let fd: number;
  try {
    fd = fs.openSync(
      t.targetPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        extraFlags,
      effectiveMode ?? 0o666,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw symlinkRefused(t.targetPath, err);
    }
    throw err;
  }
  try {
    // fstat validates the type on the opened fd, catching any non-regular
    // file that slipped past the lstatSync pre-check via a TOCTOU race.
    if (!fs.fstatSync(fd).isFile()) {
      throw notRegularFile(t.targetPath);
    }
    writeAll(fd, t.content);
    // Content is committed to the fd — track it now so that a subsequent
    // fchmodSync failure (mode-only, content intact) still reports this
    // path as written. closeSync in the finally below flushes the data.
    writtenPaths.push(t.targetPath);
    // Apply mode via fd before close — sets permissions on the inode
    // without re-traversing the path after close (no TOCTOU).
    if (effectiveMode !== undefined) {
      fs.fchmodSync(fd, effectiveMode);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Windows path (O_NOFOLLOW unavailable).
function writeWithoutNoFollow(
  t: WriteTarget,
  existingEntry: fs.Stats | undefined,
  effectiveMode: number | undefined,
  writtenPaths: string[],
): void {
  if (existingEntry?.isSymbolicLink()) {
    throw symlinkRefused(t.targetPath);
  }
  fs.writeFileSync(t.targetPath, t.content, {
    mode: effectiveMode ?? 0o666,
  });
  // Content written — push now so a subsequent chmodSync failure still
  // reports this path as written for partial-history purposes.
  writtenPaths.push(t.targetPath);
  // O_CREAT + writeFileSync handles the mode via the open(2) mode argument;
  // the chmodSync below is belt-and-suspenders for the case where the file
  // pre-existed with different permissions.
  if (effectiveMode !== undefined) {
    fs.chmodSync(t.targetPath, effectiveMode);
  }
}
