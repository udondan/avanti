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
  /** true when a chmod op was silently skipped (ENOENT/ELOOP) — not an error */
  skipped?: boolean;
  /** base64-encoded file content, set for read/readlink/stat-read ops */
  contentB64?: string;
  /** true when stat-read resolved a symlink (contentB64 is the link target) */
  isSymlink?: boolean;
}

export interface WorkerResponse {
  results: WorkerResult[];
}

// Thrown by dispatch() when a chmod op is silently skipped (ENOENT/ELOOP).
// Not an error — caught in the main dispatch loop to emit { ok: true, skipped: true }.
class OopSkipped extends Error {}

// Thrown by dispatch() to return base64 content from a read/readlink/stat-read op.
// dispatch() returns void, so out-of-band data travels via a typed throw.
class OopRead extends Error {
  constructor(
    public readonly contentB64: string,
    public readonly isSymlink: boolean,
  ) {
    super();
  }
}

function randomHex(): string {
  return crypto.randomBytes(5).toString('hex');
}

function getExistingMode(filePath: string): string | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return undefined;
    return (stat.mode & 0o7777).toString(8).padStart(4, '0');
  } catch {
    return undefined;
  }
}

// parseInt('0o644', 8) stops at 'o' and returns 0, silently setting permissions
// to 0000. Strip the prefix so both '0644' and '0o644' parse correctly.
function parseMode(modeStr: string): number {
  const stripped = modeStr.replace(/^0[oO]/, '');
  const result = parseInt(stripped, 8);
  if (isNaN(result)) throw new Error(`invalid mode: ${modeStr}`);
  return result;
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
  // Only back up regular files (not symlinks, not absent).
  try {
    if (!fs.lstatSync(targetPath).isFile()) return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
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

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o755 });
  // Re-validate after mkdirSync: dirs just created (or that appeared during
  // the race window between the pre-dispatch check and mkdirSync) are now
  // visible and can be properly verified.
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedBackup, trustedUids, 'backup');

  const backupTmp = path.join(
    path.resolve(backupDir),
    `.avanti-backup-${randomHex()}`,
  );

  // O_EXCL creation — prevents TOCTOU in the backup staging directory. Keep
  // the fd open and write through it so no path-based TOCTOU window opens
  // between open and write.
  let bfd: number | undefined;
  let sfd: number | undefined;
  try {
    // Open source with O_NOFOLLOW|O_NONBLOCK to reject symlinks and FIFOs; fstat
    // to verify it is still a regular file before reading.
    sfd = fs.openSync(
      targetPath,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
    const srcStat = fs.fstatSync(sfd);
    if (!srcStat.isFile()) {
      throw new Error(
        `backup source ${targetPath} is not a regular file; refusing to back up`,
      );
    }
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
    try {
      fs.unlinkSync(backupTmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export function handleWriteMv(op: WriteMvOp, trustedUids?: Set<number>): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  // Re-validate after mkdirSync: dirs that appeared or were created during the
  // race window between the pre-dispatch ancestor check and mkdirSync are now
  // visible and can be properly verified.
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');

  const existingMode = op.mode ? undefined : getExistingMode(resolvedTarget);

  // O_EXCL temp in destination directory. Keep the fd open and write through
  // it so no path-based TOCTOU window opens between open and write.
  const tmpPath = path.join(dir, `.avanti-${randomHex()}`);
  let tfd: number | undefined;
  try {
    tfd = fs.openSync(tmpPath, 'wx', 0o600);
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
    throw err;
  }
}

export function handleWriteInPlace(
  op: WriteInPlaceOp,
  trustedUids?: Set<number>,
): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

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
        if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
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
          } catch {
            // best-effort restore
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
      // If we temporarily boosted the mode via rfd, restore it before closing.
      if (rfd !== undefined && savedMode !== undefined) {
        try {
          safeFchmodSync(rfd, savedMode);
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

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (trustedUids)
    checkAncestorsSafeAsRoot(resolvedTarget, trustedUids, 'destination');

  // Refuse to overwrite a real directory with a symlink.
  try {
    const lst = fs.lstatSync(resolvedTarget);
    if (!lst.isSymbolicLink() && lst.isDirectory()) {
      throw new Error(
        `symlink: ${op.targetPath} is a directory; refusing to replace it with a symlink`,
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (op.backupPath) {
    try {
      const lst = fs.lstatSync(resolvedTarget);
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
  try {
    fs.unlinkSync(path.resolve(op.targetPath));
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
      try {
        const s = fs.statSync(absDir);
        mode = s.mode & 0o7777;
        targetOwnerUid = s.uid;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2;
        // Dangling symlink — ownerUid is captured; fall through for owner check.
      }
      if (targetOwnerUid === undefined) {
        throw new Error(
          `privileged write: ${label} directory ${absDir} symlink target UID unknown (TOCTOU risk)`,
        );
      }
      if (!trustedUids.has(targetOwnerUid)) {
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

export function dispatch(op: WriteOp, trustedUids?: Set<number>): void {
  switch (op.type) {
    case 'write-mv':
      handleWriteMv(op, trustedUids);
      break;
    case 'write-in-place':
      handleWriteInPlace(op, trustedUids);
      break;
    case 'write-symlink':
      handleWriteSymlink(op, trustedUids);
      break;
    case 'delete':
      handleDelete(op);
      break;
    case 'chmod': {
      const resolvedPath = path.resolve(op.targetPath);
      let fd: number | undefined;
      try {
        // O_NOFOLLOW rejects symlinks (ELOOP); O_NONBLOCK prevents blocking on
        // FIFOs. Using fchmodSync on the fd eliminates the lstat→chmod TOCTOU
        // window that would otherwise allow a root-privilege symlink swap.
        // For write-only files (mode 0o200) under a named-user sudo identity,
        // O_RDONLY fails with EACCES — fall back to O_WRONLY (no O_TRUNC so
        // content is not affected) to still obtain a valid fd for fchmodSync.
        try {
          fd = fs.openSync(
            resolvedPath,
            fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EACCES') {
            fd = fs.openSync(
              resolvedPath,
              fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
            );
          } else {
            throw e;
          }
        }
        safeFchmodSync(fd, parseMode(op.mode));
        fs.closeSync(fd);
      } catch (e) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // best-effort close
          }
        }
        const code = (e as NodeJS.ErrnoException).code;
        // ENOENT: file gone since diff — skip silently.
        // ELOOP: O_NOFOLLOW rejected a symlink — skip silently.
        // Throw OopSkipped so the caller can record { ok: true, skipped: true }
        // instead of { ok: true } — needed to avoid inflating mode-only counts.
        if (code === 'ENOENT' || code === 'ELOOP') throw new OopSkipped();
        throw e;
      }
      break;
    }
    case 'read': {
      const resolvedPath = path.resolve(op.targetPath);
      const buf = fs.readFileSync(resolvedPath);
      // Content is returned via the caller's results array — the dispatch
      // function returns void, so we throw a sentinel carrying the data.
      throw new OopRead(buf.toString('base64'), false);
    }
    case 'readlink': {
      const resolvedPath = path.resolve(op.targetPath);
      const target = fs.readlinkSync(resolvedPath);
      throw new OopRead(Buffer.from(target).toString('base64'), false);
    }
    case 'stat-read': {
      const resolvedPath = path.resolve(op.targetPath);
      const lst = fs.lstatSync(resolvedPath);
      if (lst.isSymbolicLink()) {
        const target = fs.readlinkSync(resolvedPath);
        throw new OopRead(Buffer.from(target).toString('base64'), true);
      }
      const buf = fs.readFileSync(resolvedPath);
      throw new OopRead(buf.toString('base64'), false);
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

  process.stdin.on('error', (err) => {
    process.stderr.write(`stdin error: ${err.message}\n`);
    process.exitCode = 1;
    rl.close();
  });

  const checkedDirs = new Set<string>();

  rl.on('line', (line: string) => {
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
      return;
    }

    const trustedUids = request.trustedUids
      ? new Set(request.trustedUids)
      : undefined;
    const continueOnError = request.continueOnError ?? false;

    const results: WorkerResult[] = [];
    for (const op of request.ops) {
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
        dispatch(op, trustedUids);
        results.push({ ok: true });
      } catch (e) {
        if (e instanceof OopSkipped) {
          results.push({ ok: true, skipped: true });
        } else if (e instanceof OopRead) {
          results.push({
            ok: true,
            contentB64: e.contentB64,
            isSymlink: e.isSymlink,
          });
        } else {
          results.push({ ok: false, error: (e as Error).message });
          if (!continueOnError) break; // fail-fast for writes; continue for deletes
        }
      }
    }
    process.stdout.write(JSON.stringify({ results }) + '\n');
  });

  rl.on('close', () => {
    // stdin closed — session ended naturally
  });
}
