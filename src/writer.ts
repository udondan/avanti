import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface WriteTarget {
  targetPath: string;
  content: Buffer;
  mode?: string;
  backupPath?: string;
  writeInPlace?: boolean;
  sudo?: boolean | string;
}

export function sudoUserArgs(sudo: boolean | string): string[] {
  return typeof sudo === 'string' ? ['-u', sudo] : [];
}

export function sudoAuth(sudo: boolean | string = true): void {
  if (process.platform === 'win32') {
    throw new Error('sudo is not supported on Windows');
  }
  const result = spawnSync('sudo', [...sudoUserArgs(sudo), '-v'], {
    stdio: 'inherit',
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error
      ? result.error.message
      : `exit code ${result.status ?? 'unknown'}`;
    throw new Error(`sudo authentication failed: ${detail}`);
  }
}

export function sudoAtomicWrite(targets: WriteTarget[]): void {
  const mvTargets = targets.filter((t) => !t.writeInPlace);
  const inPlaceTargets = targets.filter((t) => t.writeInPlace);
  for (const t of mvTargets) {
    sudoWriteMv(t);
  }
  for (const t of inPlaceTargets) {
    sudoWriteInPlace(t);
  }
}

export function sudoDelete(p: string, sudo: boolean | string): void {
  const r = spawnSync('sudo', [...sudoUserArgs(sudo), 'rm', '-f', '--', p], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.warn(`Warning: could not delete ${p}`);
  }
}

function sudoRun(sudo: boolean | string, args: string[]): void {
  const r = spawnSync('sudo', [...sudoUserArgs(sudo), ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0 || r.error) {
    throw new Error(`sudo ${args.join(' ')} failed`);
  }
}

// Returns the existing file's permission bits as an octal string via sudo stat,
// trying GNU stat (-c %a) then BSD/macOS stat (-f %Lp). Returns undefined when
// the file does not exist or the mode cannot be determined.
function getSudoFileMode(
  sudo: boolean | string,
  targetPath: string,
): string | undefined {
  const gnu = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-c', '%a', '--', targetPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (gnu.status === 0) return gnu.stdout.toString().trim() || undefined;
  const bsd = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-f', '%Lp', targetPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (bsd.status === 0) return bsd.stdout.toString().trim() || undefined;
  return undefined;
}

function sudoWriteMv(t: WriteTarget): void {
  const sudo = t.sudo!;
  const dir = path.dirname(t.targetPath);
  sudoRun(sudo, ['mkdir', '-p', '--', dir]);

  // Capture existing mode before writing so we can restore it after mv.
  // Explicit config mode wins; existing dest mode used as fallback.
  const existingMode = t.mode ? undefined : getSudoFileMode(sudo, t.targetPath);

  const tmpName =
    '.' +
    path.basename(t.targetPath) +
    '.' +
    crypto.randomBytes(8).toString('hex') +
    '.avanti-tmp';
  const tmpFile = path.join(dir, tmpName);
  let backupTmp: string | undefined;

  try {
    const tee = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'tee', '--', tmpFile],
      { input: t.content, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    if (tee.status !== 0 || tee.error) {
      throw new Error(`sudo write failed for ${t.targetPath}`);
    }

    if (t.backupPath) {
      const isSymlink = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-L', '--', t.targetPath],
        { stdio: 'ignore' },
      );
      const isFile =
        isSymlink.status !== 0 &&
        spawnSync(
          'sudo',
          [...sudoUserArgs(sudo), 'test', '-f', '--', t.targetPath],
          { stdio: 'ignore' },
        ).status === 0;
      if (isFile) {
        const backupDir = path.dirname(t.backupPath);
        sudoRun(sudo, ['mkdir', '-p', '--', backupDir]);
        backupTmp = path.join(
          backupDir,
          '.' +
            path.basename(t.backupPath) +
            '.' +
            crypto.randomBytes(8).toString('hex') +
            '.avanti-tmp',
        );
        sudoRun(sudo, ['cp', '--', t.targetPath, backupTmp]);
        sudoRun(sudo, ['mv', '--', backupTmp, t.backupPath]);
        backupTmp = undefined; // renamed into place — no cleanup needed
      }
    }

    sudoRun(sudo, ['mv', '--', tmpFile, t.targetPath]);

    // Apply mode: explicit config value wins; otherwise restore the destination's
    // pre-write mode so sudo mv doesn't silently reset it to the umask default.
    const effectiveMode = t.mode ?? existingMode;
    if (effectiveMode) {
      sudoRun(sudo, ['chmod', '--', effectiveMode, t.targetPath]);
    }
  } finally {
    try {
      sudoRun(sudo, ['rm', '-f', '--', tmpFile]);
    } catch {
      // best-effort cleanup
    }
    if (backupTmp) {
      try {
        sudoRun(sudo, ['rm', '-f', '--', backupTmp]);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function sudoWriteInPlace(t: WriteTarget): void {
  const sudo = t.sudo!;
  const dir = path.dirname(t.targetPath);
  sudoRun(sudo, ['mkdir', '-p', '--', dir]);

  let backupTmp: string | undefined;

  try {
    if (t.backupPath) {
      const isSymlink = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-L', '--', t.targetPath],
        { stdio: 'ignore' },
      );
      const isFile =
        isSymlink.status !== 0 &&
        spawnSync(
          'sudo',
          [...sudoUserArgs(sudo), 'test', '-f', '--', t.targetPath],
          { stdio: 'ignore' },
        ).status === 0;
      if (isFile) {
        const backupDir = path.dirname(t.backupPath);
        sudoRun(sudo, ['mkdir', '-p', '--', backupDir]);
        backupTmp = path.join(
          backupDir,
          '.' +
            path.basename(t.backupPath) +
            '.' +
            crypto.randomBytes(8).toString('hex') +
            '.avanti-tmp',
        );
        sudoRun(sudo, ['cp', '--', t.targetPath, backupTmp]);
        sudoRun(sudo, ['mv', '--', backupTmp, t.backupPath]);
        backupTmp = undefined;
      }
    }

    const tee = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'tee', '--', t.targetPath],
      { input: t.content, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    if (tee.status !== 0 || tee.error) {
      throw new Error(`sudo write failed for ${t.targetPath}`);
    }

    if (t.mode) {
      sudoRun(sudo, ['chmod', '--', t.mode, t.targetPath]);
    }
  } finally {
    if (backupTmp) {
      try {
        sudoRun(sudo, ['rm', '-f', '--', backupTmp]);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function atomicWrite(
  targets: WriteTarget[],
  deletions: string[] = [],
): void {
  // Stage each file as a sibling temp file on the same filesystem as the
  // destination so that renameSync (rename(2)) is atomic on POSIX.
  const mvTargets = targets.filter((t) => !t.writeInPlace);
  const inPlaceTargets = targets.filter((t) => t.writeInPlace);
  const staged: Array<{ tmp: string; dest: string; effectiveMode?: number }> =
    [];
  const backupTemps: string[] = [];
  try {
    // Phase 1 (mv targets): write all temp files. Backups are deferred to
    // Phase 2 so that a staging failure here never creates an orphaned backup
    // for a destination that hasn't been modified yet.
    // In-place targets skip this phase (no temp file); their backups are still
    // created in Phase 2. If Phase 4 fails after open (which truncates the
    // file), the destination may be empty or partially written — the backup
    // captures the pre-write content and can be used for recovery.
    for (const t of mvTargets) {
      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = path.join(
        dir,
        '.' +
          path.basename(t.targetPath) +
          '.' +
          crypto.randomBytes(8).toString('hex') +
          '.avanti-tmp',
      );
      // O_CREAT|O_EXCL rejects any pre-existing entry at this path (including
      // symlinks — POSIX guarantees EEXIST when O_EXCL is set and the path
      // resolves to a symlink). O_NOFOLLOW is belt-and-suspenders on POSIX.
      // The random suffix makes pre-creation attacks impractical regardless.
      const oNoFollow: number =
        (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
      const tmpFd = fs.openSync(
        tmpFile,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          oNoFollow,
        0o666,
      );
      // Register for cleanup before the write so a writeSync failure (e.g.
      // ENOSPC) doesn't leave an orphan .avanti-tmp in the target directory.
      const stagingEntry: (typeof staged)[0] = {
        tmp: tmpFile,
        dest: t.targetPath,
      };
      staged.push(stagingEntry);
      try {
        let written = 0;
        while (written < t.content.length) {
          written += fs.writeSync(
            tmpFd,
            t.content,
            written,
            t.content.length - written,
          );
        }
      } finally {
        fs.closeSync(tmpFd);
      }

      // Resolve the effective mode: explicit config value wins; otherwise
      // preserve the existing file's full permission bits (0o7777) so rename(2)
      // doesn't silently reset them to the umask default. New files get the
      // OS umask default.
      let effectiveMode: number | undefined;
      if (t.mode) {
        effectiveMode = parseInt(t.mode, 8);
      } else {
        try {
          effectiveMode = fs.statSync(t.targetPath).mode & 0o7777;
        } catch {
          // file doesn't exist yet — leave the temp file's umask permissions
        }
      }

      stagingEntry.effectiveMode = effectiveMode;
    }

    // Phase 2: all staging succeeded — now create backups.
    // Phase 2a: copy each source file to a uniquely-named temp in the backup
    // dir. If any copy fails, no backup destination has been touched yet.
    const backupRenames: Array<{ tmp: string; dest: string }> = [];
    for (const t of targets) {
      if (
        t.backupPath &&
        fs.lstatSync(t.targetPath, { throwIfNoEntry: false })?.isFile()
      ) {
        const backupDir = path.dirname(t.backupPath);
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }
        // Copy via a uniquely-named temp file then rename so that:
        // (a) a symlink at backupPath is replaced, not followed, and
        // (b) a predictable temp path cannot be pre-created as a symlink.
        const backupTmp = path.join(
          backupDir,
          '.' +
            path.basename(t.backupPath) +
            '.' +
            crypto.randomBytes(8).toString('hex') +
            '.avanti-tmp',
        );
        backupTemps.push(backupTmp);
        fs.copyFileSync(t.targetPath, backupTmp);
        backupRenames.push({ tmp: backupTmp, dest: t.backupPath });
      }
    }
    // Phase 2b: all copies succeeded — rename each backup temp into place.
    for (const { tmp, dest } of backupRenames) {
      fs.renameSync(tmp, dest);
    }

    // Phase 3: atomically rename each temp file into place
    for (const s of staged) {
      fs.renameSync(s.tmp, s.dest);
      if (s.effectiveMode !== undefined) {
        fs.chmodSync(s.dest, s.effectiveMode);
      }
    }

    // Phase 4: in-place writes — preserve inode, not atomic
    for (const t of inPlaceTargets) {
      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
        throw new Error(
          `writeInPlace: ${t.targetPath} is not a regular file; refusing to write`,
        );
      }
      let effectiveMode: number | undefined;
      if (t.mode) {
        effectiveMode = parseInt(t.mode, 8);
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
      const oNoFollow: number =
        (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
      const oNonBlock: number =
        (fs.constants as Record<string, number>)['O_NONBLOCK'] ?? 0;
      if (oNoFollow !== 0) {
        let fd: number;
        try {
          fd = fs.openSync(
            t.targetPath,
            fs.constants.O_WRONLY |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              oNoFollow |
              oNonBlock,
            effectiveMode ?? 0o666,
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
            throw new Error(
              `writeInPlace: ${t.targetPath} is a symlink; refusing to follow`,
              { cause: err },
            );
          }
          throw err;
        }
        try {
          // fstat validates the type on the opened fd, catching any non-regular
          // file that slipped past the lstatSync pre-check via a TOCTOU race.
          if (!fs.fstatSync(fd).isFile()) {
            throw new Error(
              `writeInPlace: ${t.targetPath} is not a regular file; refusing to write`,
            );
          }
          let written = 0;
          while (written < t.content.length) {
            written += fs.writeSync(
              fd,
              t.content,
              written,
              t.content.length - written,
            );
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        if (existingEntry?.isSymbolicLink()) {
          throw new Error(
            `writeInPlace: ${t.targetPath} is a symlink; refusing to follow`,
          );
        }
        fs.writeFileSync(t.targetPath, t.content, {
          mode: effectiveMode ?? 0o666,
        });
      }
      if (effectiveMode !== undefined) {
        fs.chmodSync(t.targetPath, effectiveMode);
      }
    }
  } finally {
    for (const tmp of backupTemps) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // already renamed into place or never created
      }
    }
    for (const s of staged) {
      try {
        fs.rmSync(s.tmp, { force: true });
      } catch {
        // already renamed into place or never created
      }
    }
  }

  // Deletions happen after writes succeed; each failure is non-fatal
  for (const p of deletions) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.warn(
        `Warning: could not delete ${p}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
