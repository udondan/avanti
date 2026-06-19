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

export type WriteOp = WriteMvOp | WriteInPlaceOp | WriteSymlinkOp | DeleteOp;

export interface WorkerRequest {
  ops: WriteOp[];
  trustedUids?: number[];
  continueOnError?: boolean;
}

export interface WorkerResult {
  ok: boolean;
  error?: string;
}

export interface WorkerResponse {
  results: WorkerResult[];
}

function randomHex(): string {
  return crypto.randomBytes(5).toString('hex');
}

function getExistingMode(filePath: string): string | undefined {
  try {
    return (fs.statSync(filePath).mode & 0o7777).toString(8).padStart(4, '0');
  } catch {
    return undefined;
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

  const backupDir = path.dirname(backupPath);
  const resolvedBackup = path.resolve(backupPath);

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
    const srcMode = (srcStat.mode & 0o7777).toString(8).padStart(4, '0');
    bfd = fs.openSync(backupTmp, 'wx', 0o600);
    fs.writeFileSync(bfd, fs.readFileSync(sfd));
    fs.fchmodSync(bfd, parseInt(srcMode, 8));
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
    fs.fchmodSync(tfd, parseInt(effectiveMode, 8));
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
        fs.fchmodSync(fd, parseInt(effectiveMode, 8));
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
    // Open with O_NOFOLLOW to reject symlinks and O_NONBLOCK to avoid hanging
    // on a FIFO (O_NONBLOCK makes opening a write-end FIFO without a reader
    // fail immediately instead of blocking). fstat after open verifies the
    // file is still a regular file — O_NOFOLLOW rejects symlinks but not FIFOs.
    // Named-user sudo: if the target file is not writable by the target user
    // (EACCES), open it read-only first to get an fd, fstat to verify it is a
    // regular file, then fchmod via the fd to add a write bit. This avoids the
    // path-based chmod→open TOCTOU window. The mode is always restored to
    // either the explicitly requested value or the original after the write.
    const openFlags =
      fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW | O_NONBLOCK;
    let fd: number | undefined;
    let rfd: number | undefined;
    let savedMode: number | undefined;
    // Capture the initial open error so we can do EACCES recovery outside the
    // catch block, avoiding the preserve-caught-error lint constraint.
    let firstOpenErr: NodeJS.ErrnoException | undefined;
    try {
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
          // Named-user sudo: add write bit via fd-based fchmod, then retry.
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
          fs.fchmodSync(rfd, savedMode | 0o200);
          try {
            fd = fs.openSync(resolvedTarget, openFlags);
          } catch (retryErr) {
            fs.fchmodSync(rfd, savedMode);
            throw retryErr;
          }
        } else {
          throw firstOpenErr;
        }
      }
      // After the recovery block: either fd was set by the initial open
      // (firstOpenErr undefined) or by the retry (recovery path). All other
      // branches throw, so fd is always a number here.
      if (fd === undefined)
        throw new Error('writeInPlace: internal error: fd not set');
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) {
        throw new Error(
          `writeInPlace: ${op.targetPath} is not a regular file after open; refusing to write`,
        );
      }
      fs.writeFileSync(fd, content);
      // When we used the write-bit-boost path, always fchmod to restore the
      // mode (either the explicitly requested mode or the original). Otherwise
      // preserve the original behaviour: only fchmod when effectiveMode is set.
      const finalMode =
        effectiveMode !== undefined
          ? parseInt(effectiveMode, 8)
          : savedMode !== undefined
            ? savedMode
            : undefined;
      if (finalMode !== undefined) {
        fs.fchmodSync(fd, finalMode);
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
          fs.fchmodSync(rfd, savedMode);
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
      if (lst.isSymbolicLink() || lst.isFile()) {
        const backupDir = path.dirname(op.backupPath);
        const resolvedBackup = path.resolve(op.backupPath);

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
          if (lst.isSymbolicLink()) {
            // Store the symlink as absolute target so backup resolves correctly
            // from backupDir regardless of whether the original was relative.
            const rawTarget = fs.readlinkSync(resolvedTarget);
            const absTarget = path.isAbsolute(rawTarget)
              ? rawTarget
              : path.resolve(path.dirname(resolvedTarget), rawTarget);
            fs.symlinkSync(absTarget, backupTmp);
          } else {
            // Open source with O_NOFOLLOW|O_NONBLOCK to reject symlinks and
            // FIFOs; fstat to verify it is still a regular file before reading.
            // Keep the backup fd open and write through it — no path-based
            // TOCTOU between open and write.
            let sfd: number | undefined;
            let bfd: number | undefined;
            try {
              sfd = fs.openSync(
                resolvedTarget,
                fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
              );
              const srcStat = fs.fstatSync(sfd);
              if (!srcStat.isFile()) {
                throw new Error(
                  `backup source ${op.targetPath} is not a regular file; refusing to back up`,
                );
              }
              const srcMode = (srcStat.mode & 0o7777)
                .toString(8)
                .padStart(4, '0');
              bfd = fs.openSync(backupTmp, 'wx', 0o600);
              fs.writeFileSync(bfd, fs.readFileSync(sfd));
              fs.fchmodSync(bfd, parseInt(srcMode, 8));
              fs.closeSync(bfd);
              bfd = undefined;
              fs.closeSync(sfd);
              sfd = undefined;
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
              throw err;
            }
          }
          fs.renameSync(backupTmp, resolvedBackup);
        } catch (err) {
          try {
            fs.unlinkSync(backupTmp);
          } catch {
            // best-effort cleanup
          }
          throw err;
        }
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
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break;
  }
  for (const ancestor of ancestors) {
    checkDirSafeAsRoot(ancestor, trustedUids, label);
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
    default: {
      const _exhaustive: never = op;
      throw new Error(`unknown op type: ${(_exhaustive as WriteOp).type}`);
    }
  }
}

// Entry point: only run when this file is the main module, not when imported.
if (require.main === module) {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    let request: WorkerRequest;
    try {
      request = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as WorkerRequest;
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
      process.exit(1);
      return;
    }

    const trustedUids = request.trustedUids
      ? new Set(request.trustedUids)
      : undefined;
    const continueOnError = request.continueOnError ?? false;

    const results: WorkerResult[] = [];
    for (const op of request.ops) {
      try {
        if (trustedUids) {
          checkAncestorsSafeAsRoot(op.targetPath, trustedUids, 'destination');
          if (op.type !== 'delete' && op.backupPath) {
            checkAncestorsSafeAsRoot(op.backupPath, trustedUids, 'backup');
          }
        }
        dispatch(op, trustedUids);
        results.push({ ok: true });
      } catch (e) {
        results.push({ ok: false, error: (e as Error).message });
        if (!continueOnError) break; // fail-fast for writes; continue for deletes
      }
    }
    process.stdout.write(JSON.stringify({ results }) + '\n');
  });
}
