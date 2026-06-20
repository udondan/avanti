import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// O_NOFOLLOW and O_NONBLOCK are POSIX-only; fall back to 0 (no-op) on platforms
// where they are not defined (Windows). The worker is only invoked via sudo on
// Unix, so 0 is never reached in production.
const O_NOFOLLOW: number =
  (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
const O_NONBLOCK: number =
  (fs.constants as Record<string, number>).O_NONBLOCK ?? 0;

export interface WriteMvOp {
  type: 'write-mv';
  targetPath: string;
  contentB64: string;
  mode?: string;
  defaultMode: string;
  backupPath?: string;
}

export interface WriteInPlaceOp {
  type: 'write-in-place';
  targetPath: string;
  contentB64: string;
  mode?: string;
  defaultMode: string;
  backupPath?: string;
}

export interface WriteSymlinkOp {
  type: 'write-symlink';
  targetPath: string;
  symlinkTarget: string;
  backupPath?: string;
}

export interface DeleteOp {
  type: 'delete';
  targetPath: string;
}

export interface ChmodOp {
  type: 'chmod';
  targetPath: string;
  mode: string;
}

export interface ReadOp {
  type: 'read';
  targetPath: string;
}

export interface ReadlinkOp {
  type: 'readlink';
  targetPath: string;
}

export interface StatReadOp {
  type: 'stat-read';
  targetPath: string;
}

export type WriteOp =
  | WriteMvOp
  | WriteInPlaceOp
  | WriteSymlinkOp
  | DeleteOp
  | ChmodOp
  | ReadOp
  | ReadlinkOp
  | StatReadOp;

export interface WorkerRequest {
  ops: WriteOp[];
  trustedUids?: number[];
  continueOnError?: boolean;
}

export interface WorkerResult {
  ok: boolean;
  error?: string;
  /** errno code from NodeJS.ErrnoException, e.g. 'ENOENT'; set when ok is false */
  code?: string;
  /** true when a chmod op was silently skipped (ENOENT/ELOOP) — not an error */
  skipped?: boolean;
  /** base64-encoded file content, set for read/readlink/stat-read ops */
  contentB64?: string;
  /** true when stat-read resolved a symlink (contentB64 is the link target) */
  isSymlink?: boolean;
  /** octal mode string (e.g. '0644'), set by stat-read for regular files only */
  mode?: string;
}

export interface WorkerResponse {
  results: WorkerResult[];
}

type DispatchResult =
  | { kind: 'ok' }
  | { kind: 'skipped' }
  | { kind: 'read'; contentB64: string; isSymlink: boolean; mode?: string };

function randomHex(): string {
  return crypto.randomBytes(5).toString('hex');
}

// Opens resolvedPath with O_RDONLY|O_NOFOLLOW|O_NONBLOCK, verifies it is a
// regular file within the MAX_READ limit, reads it fully, and returns the
// base64-encoded contents and the file's permission bits (octal string, e.g.
// "0644"). The label ('read' or 'stat-read') is used in error messages. The fd
// is always closed, even on error. Mode is captured via fstatSync while the fd
// is still open — atomically bound to the same inode as the content being read.
function readFileToBase64(
  resolvedPath: string,
  label: string,
): { contentB64: string; mode: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      resolvedPath,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      // Attach a recognisable errno code for directories so callers (e.g.
      // sudoStatBatch) can distinguish EISDIR from a generic "not a file".
      const err = Object.assign(
        new Error(`${label}: ${resolvedPath} is not a regular file`),
        { code: st.isDirectory() ? 'EISDIR' : undefined },
      );
      throw err;
    }
    if (st.size > MAX_READ) {
      throw new Error(
        `${label}: ${resolvedPath} exceeds the 75 MiB read limit`,
      );
    }
    const mode = (st.mode & 0o7777).toString(8).padStart(4, '0');
    // Read until EOF rather than st.size bytes: st.size may be 0 for special
    // filesystems (procfs, sysfs) and also for empty regular files. Reading
    // until EOF handles both cases correctly.
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(65536);
    let n: number;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      total += n;
      if (total > MAX_READ) {
        throw new Error(
          `${label}: ${resolvedPath} exceeds the 75 MiB read limit`,
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { contentB64: Buffer.concat(chunks).toString('base64'), mode };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close */
      }
    }
  }
}

function getExistingMode(filePath: string): string | undefined {
  try {
    const lst = fs.lstatSync(filePath);
    // For symlinks, follow to the target to preserve the target file's mode
    // (matching the old `stat -L` behavior). If the target is not a regular
    // file or the link is dangling, return undefined so the caller falls back
    // to defaultMode.
    const stat = lst.isSymbolicLink() ? fs.statSync(filePath) : lst;
    if (!stat.isFile()) return undefined;
    return (stat.mode & 0o7777).toString(8).padStart(4, '0');
  } catch {
    return undefined;
  }
}

// parseInt('0o644', 8) stops at 'o' and returns 0, silently setting permissions
// to 0000. Strip the prefix so both '0644' and '0o644' parse correctly.
function parseMode(modeStr: string): number {
  const stripped = modeStr.replace(/^0[oO]/, '');
  // Validate before parsing: parseInt stops at the first non-octal character
  // and returns the partial result (e.g. "644abc" → 420), which would
  // silently set wrong permissions. The isNaN guard only catches the case
  // where the FIRST character is invalid.
  if (!/^[0-7]+$/.test(stripped)) throw new Error(`invalid mode: ${modeStr}`);
  return parseInt(stripped, 8);
}

// Buffer.from(str, 'base64') silently drops invalid characters, which can
// silently corrupt content if contentB64 is truncated (e.g. by a short-write
// on the stdin pipe). Validate before decoding so the op fails loudly.
function validateBase64(s: string, field: string): void {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new Error(`${field}: invalid base64 string (length ${s.length})`);
  }
}

// fs.fchmodSync is not implemented on Windows — no-op there since the worker
// only ever runs under sudo on Unix.
function safeFchmodSync(fd: number, mode: number): void {
  if (process.platform !== 'win32') {
    fs.fchmodSync(fd, mode);
  }
}

function backupRegularFile(
  targetPath: string,
  backupPath: string,
  trustedUids?: Set<number>,
): void {
  // Open the source first with O_NOFOLLOW so the isFile check is on the same
  // fd that will be read — eliminates the TOCTOU window between lstatSync and
  // openSync where a symlink swap could silently skip the backup.
  // O_NOFOLLOW: ELOOP if targetPath is a symlink (→ not a regular file, skip).
  // O_NONBLOCK: prevents opening FIFOs.
  let sfd: number | undefined;
  try {
    sfd = fs.openSync(
      targetPath,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return;
    throw e;
  }

  let bfd: number | undefined;
  let backupTmp: string | undefined;
  try {
    const srcStat = fs.fstatSync(sfd);
    if (!srcStat.isFile()) {
      fs.closeSync(sfd);
      sfd = undefined;
      return;
    }

    const resolvedBackup = path.resolve(backupPath);
    const backupDir = path.dirname(resolvedBackup);

    // Refuse if backup destination is a directory.
    try {
      if (fs.lstatSync(resolvedBackup).isDirectory()) {
        throw new Error(`backup path is a directory: ${backupPath}`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    // Pre-validate before mkdirSync so we catch world-writable ancestors that
    // the caller could not lstat (EACCES); re-validate after to cover any
    // intermediate directories that mkdirSync itself creates.
    if (trustedUids)
      checkAncestorsSafeAsRoot(resolvedBackup, trustedUids, 'backup');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o755 });
    if (trustedUids)
      checkAncestorsSafeAsRoot(resolvedBackup, trustedUids, 'backup');

    backupTmp = path.join(
      path.resolve(backupDir),
      `.avanti-backup-${randomHex()}`,
    );

    // O_EXCL creation — prevents TOCTOU in the backup staging directory. Keep
    // the fd open and write through it so no path-based TOCTOU window opens
    // between open and write.
    bfd = fs.openSync(backupTmp, 'wx', 0o600);
    const buf = Buffer.alloc(65536);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(sfd, buf, 0, buf.length, null)) > 0) {
      fs.writeSync(bfd, buf, 0, bytesRead);
    }
    safeFchmodSync(bfd, srcStat.mode & 0o0777);
    fs.closeSync(bfd);
    bfd = undefined;
    fs.closeSync(sfd);
    sfd = undefined;
    fs.renameSync(backupTmp, resolvedBackup);
  } catch (err) {
    if (bfd !== undefined) {
      try {
        fs.closeSync(bfd);
      } catch {
        // best-effort close
      }
    }
    if (sfd !== undefined) {
      try {
        fs.closeSync(sfd);
      } catch {
        // best-effort close
      }
    }
    if (backupTmp !== undefined) {
      try {
        fs.unlinkSync(backupTmp);
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }
}

export function handleWriteMv(op: WriteMvOp, trustedUids?: Set<number>): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  // Pre-validate before mkdirSync so we catch world-writable ancestors that
  // the caller could not lstat (EACCES); re-validate after to cover any
  // intermediate directories that mkdirSync itself creates.
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');

  const existingMode = op.mode ? undefined : getExistingMode(resolvedTarget);

  // O_EXCL temp in destination directory. Keep the fd open and write through
  // it so no path-based TOCTOU window opens between open and write.
  const tmpPath = path.join(dir, `.avanti-${randomHex()}`);
  let tfd: number | undefined;
  let backupCommitted = false;
  try {
    tfd = fs.openSync(tmpPath, 'wx', 0o600);
    validateBase64(op.contentB64, 'contentB64');
    fs.writeFileSync(tfd, Buffer.from(op.contentB64, 'base64'));

    const effectiveMode = op.mode ?? existingMode ?? op.defaultMode;
    safeFchmodSync(tfd, parseMode(effectiveMode));
    fs.closeSync(tfd);
    tfd = undefined;

    // rename(2) is atomic and never follows symlinks on any POSIX platform.
    // Refuse real directories (rename(2) would fail with EISDIR anyway, but
    // this gives a cleaner error message). Symlinks-to-directories are fine —
    // rename(2) replaces the symlink itself, not its target.
    try {
      const lst = fs.lstatSync(resolvedTarget);
      if (!lst.isSymbolicLink() && lst.isDirectory()) {
        throw new Error(`target path is a directory: ${op.targetPath}`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    // Backup AFTER staging succeeds: a staging failure no longer leaves a
    // backup behind without the new file being committed.
    if (op.backupPath) {
      backupRegularFile(resolvedTarget, op.backupPath, trustedUids);
      backupCommitted = true;
    }

    fs.renameSync(tmpPath, resolvedTarget);
  } catch (err) {
    if (tfd !== undefined) {
      try {
        fs.closeSync(tfd);
      } catch {
        // best-effort close
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    // If the backup was committed but the write rename failed, remove the
    // orphaned backup — the original is still intact at resolvedTarget.
    if (backupCommitted && op.backupPath) {
      try {
        fs.unlinkSync(path.resolve(op.backupPath));
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

export function handleWriteInPlace(
  op: WriteInPlaceOp,
  trustedUids?: Set<number>,
): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');

  if (op.backupPath) {
    backupRegularFile(resolvedTarget, op.backupPath, trustedUids);
  }

  // Refuse symlinks (would follow to unintended target).
  // Refuse non-regular files (FIFOs, devices, sockets).
  let isNewFile = false;
  try {
    const lst = fs.lstatSync(resolvedTarget);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `writeInPlace: ${op.targetPath} is a symlink; refusing to follow`,
      );
    }
    if (!lst.isFile()) {
      throw new Error(
        `writeInPlace: ${op.targetPath} is not a regular file; refusing to write`,
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      isNewFile = true;
    } else {
      throw e;
    }
  }

  validateBase64(op.contentB64, 'contentB64');
  const content = Buffer.from(op.contentB64, 'base64');
  const effectiveMode = op.mode ?? (isNewFile ? op.defaultMode : undefined);

  if (isNewFile) {
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
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // best-effort close
        }
      }
      throw err;
    }
  } else {
    // Open read-only first (O_NOFOLLOW|O_NONBLOCK) to:
    //   1. Verify the file is still a regular file (not a symlink/FIFO).
    //   2. Capture the current mode including setuid/setgid bits BEFORE the
    //      O_TRUNC write-open clears them on Linux.
    // Then open for writing. If the write-open fails with EACCES (named-user
    // sudo running as a non-root uid), fchmod via the read fd to temporarily
    // add a write bit, retry, then always restore the original mode.
    const openFlags =
      fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW | O_NONBLOCK;
    let fd: number | undefined;
    let rfd: number | undefined;
    let savedMode: number | undefined;
    // Capture the initial write-open error so we can do EACCES recovery
    // outside the catch block, avoiding the preserve-caught-error lint constraint.
    let firstOpenErr: NodeJS.ErrnoException | undefined;
    try {
      try {
        rfd = fs.openSync(
          resolvedTarget,
          fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
        );
        const rst = fs.fstatSync(rfd);
        if (!rst.isFile()) {
          throw new Error(
            `writeInPlace: ${op.targetPath} is not a regular file; refusing to write`,
          );
        }
        savedMode = rst.mode & 0o7777;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          // TOCTOU: a symlink was placed at the path after the lstatSync check
          // above but before O_NOFOLLOW openSync. Surface a clear error.
          throw new Error(
            `writeInPlace: ${op.targetPath} is a symlink; refusing to follow`,
            { cause: e },
          );
        }
        if (code !== 'EACCES') throw e;
        // Write-only file (e.g. mode 0200): O_RDONLY fails with EACCES.
        // Fall back to a path-based stat to capture the mode; the write open
        // below will succeed directly so no rfd-based EACCES recovery is needed.
        // Use lstatSync (not statSync) to avoid following symlinks — the caller
        // already verified the path is a regular file via lstatSync above.
        const rst = fs.lstatSync(resolvedTarget);
        if (!rst.isFile()) {
          throw new Error(
            `writeInPlace: ${op.targetPath} is not a regular file; refusing to write`,
            { cause: e },
          );
        }
        savedMode = rst.mode & 0o7777;
        // rfd stays undefined — no EACCES recovery fchmod needed.
      }

      try {
        fd = fs.openSync(resolvedTarget, openFlags);
      } catch (e) {
        firstOpenErr = e as NodeJS.ErrnoException;
      }
      if (firstOpenErr !== undefined) {
        if (
          firstOpenErr.code === 'EACCES' &&
          typeof process.getuid === 'function' &&
          process.getuid() !== 0
        ) {
          // Named-user sudo: temporarily add the write bit so we can open the
          // file for writing. Prefer fd-based fchmod (via rfd) when available
          // to avoid a path-based TOCTOU window. Fall back to path-based
          // chmodSync when rfd is undefined (e.g. mode-0000 files where the
          // read-open also failed with EACCES — lstatSync captured the mode).
          const mode = savedMode ?? 0;
          if (rfd !== undefined) {
            // fd-based path: no TOCTOU window between stat and chmod.
            try {
              safeFchmodSync(rfd, mode | 0o200);
            } catch {
              throw firstOpenErr;
            }
          } else {
            // Path-based fallback: only works if the named user owns the file.
            try {
              fs.chmodSync(resolvedTarget, mode | 0o200);
            } catch {
              throw firstOpenErr;
            }
          }
          try {
            fd = fs.openSync(resolvedTarget, openFlags);
          } catch (retryErr) {
            // Restore original mode before surfacing the error.
            try {
              if (rfd !== undefined) {
                safeFchmodSync(rfd, mode);
              } else {
                fs.chmodSync(resolvedTarget, mode);
              }
            } catch {
              // best-effort restore
            }
            throw retryErr;
          }
          // Restore original mode immediately after the write-open succeeds —
          // the write bit was temporary. The conditional fchmod below handles
          // explicit mode and setuid/setgid bits via fd; this restore
          // covers the case where neither applies (e.g. a plain 0o400 file).
          try {
            if (rfd !== undefined) {
              safeFchmodSync(rfd, mode);
            } else {
              fs.chmodSync(resolvedTarget, mode);
            }
          } catch (restoreErr) {
            throw new Error(
              `writeInPlace: failed to restore mode on ${op.targetPath} after temporary write-bit grant: ${(restoreErr as Error).message}`,
              { cause: restoreErr },
            );
          }
        } else {
          throw firstOpenErr;
        }
      }
      if (fd === undefined)
        throw new Error('writeInPlace: internal error: fd not set');
      // fstat after the write-open as a belt-and-suspenders check: a FIFO
      // or other non-regular file could have been substituted in the window
      // between the rfd open and fd open.
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) {
        throw new Error(
          `writeInPlace: ${op.targetPath} is not a regular file after open; refusing to write`,
        );
      }
      fs.writeFileSync(fd, content);
      // fchmod only when needed: apply explicit mode, or restore setuid/setgid
      // bits that Linux strips on O_TRUNC. Skip when neither applies — a named
      // user writing via group permission may not own the file and fchmod would
      // fail with EPERM even though the write succeeded.
      if (
        effectiveMode !== undefined ||
        (savedMode !== undefined && (savedMode & 0o7000) !== 0)
      ) {
        safeFchmodSync(
          fd,
          effectiveMode !== undefined
            ? parseMode(effectiveMode)
            : (savedMode ?? 0),
        );
      }
      fs.closeSync(fd);
      fd = undefined;
      if (rfd !== undefined) {
        fs.closeSync(rfd);
        rfd = undefined;
      }
    } catch (err) {
      // If we temporarily boosted the mode, restore it before closing.
      if (rfd !== undefined && savedMode !== undefined) {
        try {
          safeFchmodSync(rfd, savedMode);
        } catch {
          // best-effort restore
        }
      } else if (rfd === undefined && savedMode !== undefined) {
        try {
          fs.chmodSync(resolvedTarget, savedMode);
        } catch {
          // best-effort restore
        }
      }
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // best-effort close
        }
      }
      if (rfd !== undefined) {
        try {
          fs.closeSync(rfd);
        } catch {
          // best-effort close
        }
      }
      throw err;
    }
  }
}

export function handleWriteSymlink(
  op: WriteSymlinkOp,
  trustedUids?: Set<number>,
): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');

  // Refuse to overwrite a real directory with a symlink. Store the lstat
  // result for reuse in the backup check below — eliminating a second syscall
  // and the TOCTOU window between the two stats.
  let lst: fs.Stats | undefined;
  try {
    lst = fs.lstatSync(resolvedTarget);
    if (!lst.isSymbolicLink() && lst.isDirectory()) {
      throw new Error(
        `symlink: ${op.targetPath} is a directory; refusing to replace it with a symlink`,
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (op.backupPath && lst !== undefined) {
    if (lst.isSymbolicLink()) {
      const resolvedBackup = path.resolve(op.backupPath);
      const backupDir = path.dirname(resolvedBackup);

      try {
        if (fs.lstatSync(resolvedBackup).isDirectory()) {
          throw new Error(`backup path is a directory: ${op.backupPath}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }

      if (trustedUids)
        checkAncestorsSafeAsRoot(resolvedBackup, trustedUids, 'backup');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o755 });
      if (trustedUids)
        checkAncestorsSafeAsRoot(resolvedBackup, trustedUids, 'backup');
      const backupTmp = path.join(
        path.resolve(backupDir),
        `.avanti-backup-${randomHex()}`,
      );

      try {
        // Store the symlink as absolute target so backup resolves correctly
        // from backupDir regardless of whether the original was relative.
        const rawTarget = fs.readlinkSync(resolvedTarget);
        const absTarget = path.isAbsolute(rawTarget)
          ? rawTarget
          : path.resolve(path.dirname(resolvedTarget), rawTarget);
        fs.symlinkSync(absTarget, backupTmp);
        fs.renameSync(backupTmp, resolvedBackup);
      } catch (err) {
        try {
          fs.unlinkSync(backupTmp);
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
    } else if (lst.isFile()) {
      backupRegularFile(resolvedTarget, op.backupPath, trustedUids);
    }
  }

  // Stage the new symlink at a temp path, then rename atomically.
  const tmpPath = path.join(dir, `.avanti-symlink-${randomHex()}`);
  try {
    fs.symlinkSync(op.symlinkTarget, tmpPath);

    fs.renameSync(tmpPath, resolvedTarget);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export function handleDelete(op: DeleteOp): void {
  const resolved = path.resolve(op.targetPath);
  try {
    const lst = fs.lstatSync(resolved);
    if (!lst.isFile() && !lst.isSymbolicLink()) {
      throw new Error(
        `delete: ${op.targetPath} is not a regular file or symlink; refusing to unlink`,
      );
    }
    fs.unlinkSync(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
}

// Verifies that a directory is safe to use as a mktemp staging location.
// Unlike the caller-side checkDirSafe, this runs inside the privileged worker
// (as root) and therefore never returns early for EACCES — root can lstatSync
// any directory, so EACCES-owned ancestors are validated rather than skipped.
function checkDirSafeAsRoot(
  absDir: string,
  trustedUids: Set<number>,
  label: string,
): void {
  let mode: number | undefined;
  let ownerUid: number | undefined;

  try {
    const lst = fs.lstatSync(absDir);
    if (lst.isSymbolicLink()) {
      ownerUid = lst.uid;
      let targetOwnerUid: number | undefined;
      let isDangling = false;
      try {
        const s = fs.statSync(absDir);
        mode = s.mode & 0o7777;
        targetOwnerUid = s.uid;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2;
        isDangling = true;
        // Dangling symlink — ownerUid (the symlink itself) is captured above;
        // fall through to the owner check below.
      }
      if (!isDangling && targetOwnerUid === undefined) {
        throw new Error(
          `privileged write: ${label} directory ${absDir} symlink target UID unknown (TOCTOU risk)`,
        );
      }
      if (targetOwnerUid !== undefined && !trustedUids.has(targetOwnerUid)) {
        throw new Error(
          `privileged write: ${label} directory ${absDir} symlink target owned by UID ${targetOwnerUid}, not trusted (TOCTOU risk)`,
        );
      }
    } else {
      mode = lst.mode & 0o7777;
      ownerUid = lst.uid;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
    // No EACCES early return: the worker runs as root, so any stat failure
    // here is unexpected and should propagate.
  }

  if (process.platform !== 'win32') {
    const isWritable = mode !== undefined && !!(mode & 0o022);
    const hasSticky = mode !== undefined && !!(mode & 0o1000);
    if (isWritable && !hasSticky) {
      throw new Error(
        `privileged write: ${label} directory ${absDir} is group/world-writable without sticky bit (TOCTOU risk)`,
      );
    }
  }

  if (ownerUid === undefined) {
    throw new Error(
      `privileged write: ${label} directory ${absDir} owner UID unknown (TOCTOU risk)`,
    );
  }
  if (!trustedUids.has(ownerUid)) {
    throw new Error(
      `privileged write: ${label} directory ${absDir} owned by UID ${ownerUid}, not trusted (TOCTOU risk)`,
    );
  }
}

// Walks every ancestor of targetPath (from the filesystem root down to its
// parent directory) and calls checkDirSafeAsRoot on each.
function checkAncestorsSafeAsRoot(
  targetPath: string,
  trustedUids: Set<number>,
  label: string,
  checkedDirs?: Set<string>,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break;
  }
  for (const ancestor of ancestors) {
    if (checkedDirs?.has(ancestor)) continue;
    checkDirSafeAsRoot(ancestor, trustedUids, label);
    checkedDirs?.add(ancestor);
  }
}

// Base64 encoding inflates raw bytes by ~33%, so a 100 MiB file produces
// ~133 MiB of JSON output. runPrivilegedWorker uses spawnSync with a 100 MiB
// maxBuffer, meaning any file larger than ~75 MiB would overflow the buffer
// before the parent can read it. Cap reads at 75 MiB so the base64 JSON stays
// comfortably under 100 MiB. SudoWorkerSession (streaming) is unaffected.
const MAX_READ = 75 * 1024 * 1024;

export function dispatch(
  op: WriteOp,
  trustedUids?: Set<number>,
): DispatchResult {
  switch (op.type) {
    case 'write-mv':
      handleWriteMv(op, trustedUids);
      return { kind: 'ok' };
    case 'write-in-place':
      handleWriteInPlace(op, trustedUids);
      return { kind: 'ok' };
    case 'write-symlink':
      handleWriteSymlink(op, trustedUids);
      return { kind: 'ok' };
    case 'delete':
      handleDelete(op);
      return { kind: 'ok' };
    case 'chmod': {
      const resolvedPath = path.resolve(op.targetPath);
      let fd: number | undefined;
      let chmodApplied = false;
      try {
        try {
          fd = fs.openSync(
            resolvedPath,
            fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EACCES') {
            try {
              fd = fs.openSync(
                resolvedPath,
                fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
              );
            } catch (e2) {
              if ((e2 as NodeJS.ErrnoException).code === 'EACCES') {
                // Both O_RDONLY and O_WRONLY failed (e.g. mode-0000 file, or root
                // blocked by a MAC policy). Use O_PATH (Linux ≥ 2.6.39) to obtain
                // a no-permission-required fd for a TOCTOU-free fchmod. Fall back
                // to a path-based chmod with a pre-flight lstat guard on platforms
                // that lack O_PATH (macOS, Windows).
                const O_PATH_FLAG =
                  (fs.constants as Record<string, number>).O_PATH ?? 0;
                let pathFd: number | undefined;
                if (O_PATH_FLAG !== 0) {
                  try {
                    pathFd = fs.openSync(
                      resolvedPath,
                      O_PATH_FLAG | O_NOFOLLOW,
                    );
                  } catch {
                    /* fall through to path-based */
                  }
                }
                if (pathFd !== undefined) {
                  try {
                    safeFchmodSync(pathFd, parseMode(op.mode));
                    chmodApplied = true;
                  } finally {
                    fs.closeSync(pathFd);
                  }
                } else {
                  // Narrow the TOCTOU window: verify it is still a regular file
                  // immediately before the path-based chmod.
                  const lst = fs.lstatSync(resolvedPath);
                  if (!lst.isFile()) {
                    throw new Error(
                      `chmod: ${op.targetPath} is not a regular file`,
                      { cause: e2 },
                    );
                  }
                  fs.chmodSync(resolvedPath, parseMode(op.mode));
                  chmodApplied = true;
                }
              } else {
                throw e2;
              }
            }
          } else {
            throw e;
          }
        }
        if (!chmodApplied) {
          safeFchmodSync(fd!, parseMode(op.mode));
        }
        if (fd !== undefined) fs.closeSync(fd);
      } catch (e) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort close */
          }
        }
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') return { kind: 'skipped' };
        throw e;
      }
      return { kind: 'ok' };
    }
    case 'read': {
      const resolvedPath = path.resolve(op.targetPath);
      return {
        kind: 'read',
        contentB64: readFileToBase64(resolvedPath, 'read').contentB64,
        isSymlink: false,
      };
    }
    case 'readlink': {
      const resolvedPath = path.resolve(op.targetPath);
      const target = fs.readlinkSync(resolvedPath);
      return {
        kind: 'read',
        contentB64: Buffer.from(target).toString('base64'),
        isSymlink: true,
      };
    }
    case 'stat-read': {
      const resolvedPath = path.resolve(op.targetPath);
      // readFileToBase64 opens with O_NOFOLLOW. If the path is (or becomes) a
      // symlink we get ELOOP; read the link target and return it as a symlink.
      // This is both simpler and eliminates the TOCTOU window that an initial
      // lstatSync would introduce.
      const readRegular = (): DispatchResult => {
        // readFileToBase64 captures the mode via fstatSync while the fd is
        // still open — atomically bound to the same inode as the content read.
        const { contentB64, mode } = readFileToBase64(
          resolvedPath,
          'stat-read',
        );
        return { kind: 'read', contentB64, isSymlink: false, mode };
      };
      try {
        return readRegular();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ELOOP') throw e;
        // readlinkSync is path-based and has a narrow TOCTOU window: a concurrent
        // process running as the same user could replace the symlink between the
        // ELOOP above and this call. In practice avanti runs on single-user
        // machines and this window is not exploitable by a different UID.
        // If the path was replaced with a regular file in that window, readlinkSync
        // throws EINVAL — retry readFileToBase64 so the caller sees a regular file.
        try {
          const target = fs.readlinkSync(resolvedPath);
          return {
            kind: 'read',
            contentB64: Buffer.from(target).toString('base64'),
            isSymlink: true,
          };
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== 'EINVAL') throw e2;
          return readRegular();
        }
      }
    }
    default: {
      const _exhaustive: never = op;
      throw new Error(`unknown op type: ${(_exhaustive as WriteOp).type}`);
    }
  }
}

// Entry point: only run when this file is the main module, not when imported.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rl = (require('readline') as typeof import('readline')).createInterface(
    {
      input: process.stdin,
      crlfDelay: Infinity,
    },
  );

  // Shut down immediately on any unexpected error so subsequent ops are not
  // dispatched while the worker is in an unknown state.
  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `avanti privileged-worker: uncaught exception: ${err.stack ?? String(err)}\n`,
    );
    process.exitCode = 1;
    rl.close();
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `avanti privileged-worker: unhandled rejection: ${String(reason)}\n`,
    );
    process.exitCode = 1;
    rl.close();
  });

  process.stdin.on('error', (err) => {
    process.stderr.write(`stdin error: ${err.message}\n`);
    process.exitCode = 1;
    rl.close();
  });

  rl.on('line', (line: string) => {
    // Fresh per-batch: ancestor checks are not carried over across requests so
    // that a malicious interleaved rename cannot poison a future batch's checks.
    const checkedDirs = new Set<string>();
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: WorkerRequest;
    try {
      request = JSON.parse(trimmed) as WorkerRequest;
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          results: [
            {
              ok: false,
              error: `failed to parse request: ${(e as Error).message}`,
            },
          ],
        }) + '\n',
      );
      process.exitCode = 1;
      rl.close();
      return;
    }

    if (!request || !Array.isArray(request.ops)) {
      process.stdout.write(
        JSON.stringify({
          results: [
            { ok: false, error: 'invalid request: ops must be an array' },
          ],
        }) + '\n',
      );
      process.exitCode = 1;
      rl.close();
      return;
    }

    const trustedUids = request.trustedUids
      ? new Set(request.trustedUids)
      : undefined;
    const continueOnError = request.continueOnError ?? false;

    const results: WorkerResult[] = [];
    let aborted = false;
    for (const op of request.ops) {
      if (aborted) {
        break;
      }
      try {
        // Validate required fields before dispatching so errors are actionable.
        if (typeof op !== 'object' || op === null) {
          throw new Error(`invalid op: expected object, got ${typeof op}`);
        }
        const raw = op as unknown as Record<string, unknown>;
        const type = raw['type'];
        if (typeof type !== 'string') {
          throw new Error(`invalid op: missing required field "type"`);
        }
        if (typeof raw['targetPath'] !== 'string') {
          throw new Error(
            `invalid op ${type}: missing required field "targetPath"`,
          );
        }
        if (!path.isAbsolute(raw['targetPath'])) {
          throw new Error(
            `invalid op ${type}: targetPath must be absolute, got ${raw['targetPath']}`,
          );
        }
        if (
          typeof raw['backupPath'] === 'string' &&
          !path.isAbsolute(raw['backupPath'])
        ) {
          throw new Error(
            `invalid op ${type}: backupPath must be absolute, got ${raw['backupPath']}`,
          );
        }
        if (
          (type === 'write-mv' || type === 'write-in-place') &&
          typeof raw['contentB64'] !== 'string'
        ) {
          throw new Error(
            `invalid op ${type}: missing required field "contentB64"`,
          );
        }
        if (
          (type === 'write-mv' || type === 'write-in-place') &&
          typeof raw['defaultMode'] !== 'string'
        ) {
          throw new Error(
            `invalid op ${type}: missing required field "defaultMode"`,
          );
        }
        if (
          type === 'write-symlink' &&
          typeof raw['symlinkTarget'] !== 'string'
        ) {
          throw new Error(
            `invalid op write-symlink: missing required field "symlinkTarget"`,
          );
        }
        if (type === 'chmod' && typeof raw['mode'] !== 'string') {
          throw new Error(`invalid op chmod: missing required field "mode"`);
        }
        if (trustedUids) {
          checkAncestorsSafeAsRoot(
            op.targetPath,
            trustedUids,
            'destination',
            checkedDirs,
          );
          if (
            op.type !== 'delete' &&
            op.type !== 'chmod' &&
            op.type !== 'read' &&
            op.type !== 'readlink' &&
            op.type !== 'stat-read' &&
            op.backupPath
          ) {
            checkAncestorsSafeAsRoot(
              op.backupPath,
              trustedUids,
              'backup',
              checkedDirs,
            );
          }
        }
        const dr = dispatch(op, trustedUids);
        if (dr.kind === 'skipped') {
          results.push({ ok: true, skipped: true });
        } else if (dr.kind === 'read') {
          results.push({
            ok: true,
            contentB64: dr.contentB64,
            isSymlink: dr.isSymlink,
            ...(dr.mode !== undefined ? { mode: dr.mode } : {}),
          });
        } else {
          results.push({ ok: true });
        }
      } catch (e) {
        results.push({
          ok: false,
          error: (e as Error).message,
          code: (e as NodeJS.ErrnoException).code,
        });
        if (!continueOnError) aborted = true;
      }
    }
    process.stdout.write(JSON.stringify({ results }) + '\n');
  });

  rl.on('close', () => {
    // stdin closed — session ended naturally
  });
}
