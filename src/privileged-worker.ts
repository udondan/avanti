import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// O_NOFOLLOW is POSIX-only; falls back to 0 (no-op) on platforms where it is
// not defined (Windows). The worker is only invoked via sudo on Unix, so 0
// is never reached in production.
const O_NOFOLLOW: number =
  (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

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

function backupRegularFile(targetPath: string, backupPath: string): void {
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

  const backupTmp = path.join(
    path.resolve(backupDir),
    `.avanti-backup-${randomHex()}`,
  );

  // O_EXCL creation — prevents TOCTOU in the backup staging directory. Keep
  // the fd open and write through it so no path-based TOCTOU window opens
  // between open and write.
  let bfd: number | undefined;
  try {
    bfd = fs.openSync(backupTmp, 'wx', 0o600);
    const srcMode = getExistingMode(targetPath);
    fs.writeFileSync(bfd, fs.readFileSync(targetPath));
    if (srcMode !== undefined) fs.fchmodSync(bfd, parseInt(srcMode, 8));
    fs.closeSync(bfd);
    bfd = undefined;
    fs.renameSync(backupTmp, resolvedBackup);
  } catch (err) {
    if (bfd !== undefined) {
      try {
        fs.closeSync(bfd);
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

export function handleWriteMv(op: WriteMvOp): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

  const existingMode = op.mode ? undefined : getExistingMode(resolvedTarget);

  if (op.backupPath) {
    backupRegularFile(resolvedTarget, op.backupPath);
  }

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

    // On non-Linux, mv follows symlinks-to-directories; rename(2) (fs.renameSync)
    // does not. Pre-remove only when the destination is a symlink pointing at a
    // directory to avoid rename creating a file inside the dir.
    if (process.platform !== 'linux') {
      try {
        const lst = fs.lstatSync(resolvedTarget);
        if (lst.isSymbolicLink()) {
          try {
            if (fs.statSync(resolvedTarget).isDirectory()) {
              fs.unlinkSync(resolvedTarget);
            }
          } catch {
            // best-effort pre-remove
          }
        } else if (lst.isDirectory()) {
          throw new Error(`target path is a directory: ${op.targetPath}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    } else {
      try {
        const lst = fs.lstatSync(resolvedTarget);
        if (!lst.isSymbolicLink() && lst.isDirectory()) {
          throw new Error(`target path is a directory: ${op.targetPath}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }

    fs.renameSync(tmpPath, resolvedTarget);

    // On non-Linux, verify the file landed (rename is not -T safe across renames).
    if (process.platform !== 'linux') {
      try {
        const lst = fs.lstatSync(resolvedTarget);
        if (!lst.isFile() || lst.isSymbolicLink()) {
          throw new Error(
            `file did not land at expected path ${op.targetPath} (destination may have been swapped)`,
          );
        }
      } catch {
        throw new Error(
          `file did not land at expected path ${op.targetPath} (destination may have been swapped)`,
        );
      }
    }
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

export function handleWriteInPlace(op: WriteInPlaceOp): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

  if (op.backupPath) {
    backupRegularFile(resolvedTarget, op.backupPath);
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
    // Existing file: temporarily ensure owner-write so the write succeeds on
    // read-only files when the worker runs as the file owner (e.g. in tests).
    const preTeeMode = getExistingMode(resolvedTarget);
    let chmodSucceeded = false;
    if (preTeeMode !== undefined) {
      try {
        fs.chmodSync(resolvedTarget, parseInt(preTeeMode, 8) | 0o200);
        chmodSucceeded = true;
      } catch {
        // chmod failed (e.g. not owner) — proceed; open will fail if truly
        // unwritable.
      }
    }

    // O_NOFOLLOW: the kernel rejects the open if the path resolves to a
    // symlink, closing the TOCTOU window between the lstatSync check above
    // and the write.
    let fd: number | undefined;
    let modeApplied = false;
    try {
      fd = fs.openSync(
        resolvedTarget,
        fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW,
      );
      fs.writeFileSync(fd, content);
      const modeToApply =
        effectiveMode ?? (chmodSucceeded ? preTeeMode : undefined);
      if (modeToApply !== undefined) {
        fs.fchmodSync(fd, parseInt(modeToApply, 8));
        modeApplied = true;
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
    } finally {
      // On failure, restore the pre-write mode so the file doesn't stay
      // more permissive after a failed pull.
      if (preTeeMode !== undefined && chmodSucceeded && !modeApplied) {
        try {
          fs.chmodSync(resolvedTarget, parseInt(preTeeMode, 8));
        } catch {
          // best-effort mode restore
        }
      }
    }
  }
}

export function handleWriteSymlink(op: WriteSymlinkOp): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

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
            // Keep fd open and write through it — no path-based TOCTOU between
            // open and write.
            let sfd: number | undefined;
            try {
              sfd = fs.openSync(backupTmp, 'wx', 0o600);
              const srcMode = getExistingMode(resolvedTarget);
              fs.writeFileSync(sfd, fs.readFileSync(resolvedTarget));
              if (srcMode !== undefined)
                fs.fchmodSync(sfd, parseInt(srcMode, 8));
              fs.closeSync(sfd);
              sfd = undefined;
            } catch (err) {
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

    // On non-Linux, a symlink pointing at a directory would cause rename to
    // place tmpPath inside the target dir rather than replacing the symlink.
    // Pre-remove only that case.
    if (process.platform !== 'linux') {
      try {
        const lst = fs.lstatSync(resolvedTarget);
        if (lst.isSymbolicLink()) {
          try {
            if (fs.statSync(resolvedTarget).isDirectory()) {
              fs.unlinkSync(resolvedTarget);
            }
          } catch {
            // best-effort pre-remove
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }

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
  const resolved = path.resolve(targetPath);
  const parts = resolved.split(path.sep).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const dir = path.sep + parts.slice(0, i).join(path.sep);
    checkDirSafeAsRoot(dir, trustedUids, label);
  }
}

export function dispatch(op: WriteOp): void {
  switch (op.type) {
    case 'write-mv':
      handleWriteMv(op);
      break;
    case 'write-in-place':
      handleWriteInPlace(op);
      break;
    case 'write-symlink':
      handleWriteSymlink(op);
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

    const results: WorkerResult[] = [];
    for (const op of request.ops) {
      try {
        if (trustedUids) {
          checkAncestorsSafeAsRoot(op.targetPath, trustedUids, 'destination');
          if (op.type !== 'delete' && op.backupPath) {
            checkAncestorsSafeAsRoot(op.backupPath, trustedUids, 'backup');
          }
        }
        dispatch(op);
        results.push({ ok: true });
      } catch (e) {
        results.push({ ok: false, error: (e as Error).message });
        break; // fail-fast: stop at first error
      }
    }
    process.stdout.write(JSON.stringify({ results }) + '\n');
  });
}
