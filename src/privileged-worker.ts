import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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
  // O_EXCL creation — prevents TOCTOU in the backup staging directory.
  const fd = fs.openSync(backupTmp, 'wx', 0o600);
  fs.closeSync(fd);

  try {
    const srcMode = getExistingMode(targetPath);
    fs.copyFileSync(targetPath, backupTmp);
    if (srcMode !== undefined) fs.chmodSync(backupTmp, parseInt(srcMode, 8));
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

export function handleWriteMv(op: WriteMvOp): void {
  const resolvedTarget = path.resolve(op.targetPath);
  const dir = path.dirname(resolvedTarget);

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

  const existingMode = op.mode ? undefined : getExistingMode(resolvedTarget);

  if (op.backupPath) {
    backupRegularFile(resolvedTarget, op.backupPath);
  }

  // O_EXCL temp in destination directory.
  const tmpPath = path.join(dir, `.avanti-${randomHex()}`);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  fs.closeSync(fd);

  try {
    fs.writeFileSync(tmpPath, Buffer.from(op.contentB64, 'base64'));

    const effectiveMode = op.mode ?? existingMode ?? op.defaultMode;
    fs.chmodSync(tmpPath, parseInt(effectiveMode, 8));

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

  const effectiveMode = op.mode ?? (isNewFile ? op.defaultMode : undefined);

  // Capture pre-write mode so we can restore if something fails.
  const preTeeMode = isNewFile ? undefined : getExistingMode(resolvedTarget);
  let chmodSucceeded = false;

  if (isNewFile) {
    // Pre-create with owner-write so content write always succeeds regardless
    // of final mode (e.g. 0444 would block the write if applied first).
    const fd = fs.openSync(resolvedTarget, 'wx', 0o600);
    fs.closeSync(fd);
  } else if (preTeeMode !== undefined) {
    // Temporarily ensure owner-write so the write succeeds on read-only files.
    try {
      fs.chmodSync(resolvedTarget, parseInt(preTeeMode, 8) | 0o200);
      chmodSucceeded = true;
    } catch {
      // chmod failed (e.g. not owner) — proceed; writeFileSync will fail if
      // the write is actually forbidden.
    }
  }

  let modeApplied = false;
  try {
    const content = Buffer.from(op.contentB64, 'base64');
    fs.writeFileSync(resolvedTarget, content);

    const modeToApply =
      effectiveMode ?? (chmodSucceeded ? preTeeMode : undefined);
    if (modeToApply !== undefined) {
      fs.chmodSync(resolvedTarget, parseInt(modeToApply, 8));
      modeApplied = true;
    }
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
            const fd = fs.openSync(backupTmp, 'wx', 0o600);
            fs.closeSync(fd);
            const srcMode = getExistingMode(resolvedTarget);
            fs.copyFileSync(resolvedTarget, backupTmp);
            if (srcMode !== undefined) {
              fs.chmodSync(backupTmp, parseInt(srcMode, 8));
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
      console.warn(
        `Warning: could not delete ${op.targetPath}: ${(e as Error).message}`,
      );
    }
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

    const results: WorkerResult[] = [];
    for (const op of request.ops) {
      try {
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
