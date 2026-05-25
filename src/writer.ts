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
  sudo?: true | string;
  symlinkTarget?: string;
}

export type SudoWriteTarget = WriteTarget & { sudo: true | string };

export function sudoUserArgs(sudo: true | string): string[] {
  return typeof sudo === 'string' ? ['-u', sudo] : [];
}

export function sudoAuth(sudo: true | string = true): void {
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

// Each target is written atomically (mktemp → tee → mv for mv-style; tee for
// in-place), but the batch is NOT collectively atomic: a failure mid-way leaves
// earlier targets already written. This mirrors the shell-level constraint —
// true batch atomicity would require a two-phase stage+rename via a privileged
// helper, which is not implemented here.
export function sudoAtomicWrite(targets: SudoWriteTarget[]): void {
  const symlinkTargets = targets.filter((t) => t.symlinkTarget !== undefined);
  const regularTargets = targets.filter((t) => t.symlinkTarget === undefined);
  const mvTargets = regularTargets.filter((t) => !t.writeInPlace);
  const inPlaceTargets = regularTargets.filter((t) => t.writeInPlace);
  for (const t of symlinkTargets) {
    sudoSymlinkWrite(t);
  }
  for (const t of mvTargets) {
    sudoWriteMv(t);
  }
  for (const t of inPlaceTargets) {
    sudoWriteInPlace(t);
  }
}

function sudoSymlinkWrite(t: SudoWriteTarget): void {
  const sudo = t.sudo;
  const resolvedTarget = path.resolve(t.targetPath);
  const dir = path.dirname(resolvedTarget);
  sudoRun(sudo, ['mkdir', '-p', '--', dir]);

  // Refuse to write if the target path is an existing directory: ln -sf would
  // place the symlink *inside* the directory rather than replacing it.
  const isDir = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'test', '-d', resolvedTarget],
    { stdio: 'ignore' },
  );
  if (isDir.status === 0) {
    throw new Error(
      `symlink: ${t.targetPath} is a directory; refusing to replace it with a symlink`,
    );
  }

  if (t.backupPath) {
    const backupDir = path.dirname(t.backupPath);
    sudoRun(sudo, ['mkdir', '-p', '--', backupDir]);
    // cp -P preserves symlinks — back up the existing entry (file or symlink)
    // without following it. Failure is non-fatal: the symlink write still
    // proceeds so pull is not blocked when backup storage is unavailable.
    const cp = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'cp', '-P', '--', resolvedTarget, t.backupPath],
      { stdio: 'ignore' },
    );
    if (cp.status !== 0 || cp.error) {
      console.warn(`Warning: could not back up ${t.targetPath}`);
    }
  }

  // ln -sf atomically replaces any existing path (file, symlink, or nothing)
  // with the new symlink. On POSIX, ln -sf calls unlink + symlink or rename,
  // which is effectively atomic for our purposes (no partial-write window).
  sudoRun(sudo, ['ln', '-sf', '--', t.symlinkTarget!, resolvedTarget]);
}

export function sudoRead(sudo: true | string, filePath: string): Buffer | null {
  // Use sudo cat with piped stdout — no temp file, no world-writable surface,
  // no TOCTOU. maxBuffer is set high enough to cover any config file avanti
  // would manage (individual config files are always well under 100 MB).
  const absPath = path.resolve(filePath);
  const result = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'cat', '--', absPath],
    { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024 },
  );
  if (result.error) {
    // Distinguish buffer overflow (file too large to manage via sudo) from a
    // normal read failure (e.g. file absent, permission denied by sudo policy).
    if (result.error.message.includes('maxBuffer length exceeded')) {
      throw new Error(
        `${filePath} exceeds the 100 MiB sudo read limit — avanti is designed for config files, not large binaries`,
      );
    }
    return null;
  }
  if (result.status !== 0) return null;
  return result.stdout;
}

export function sudoDelete(p: string, sudo: true | string): boolean {
  const r = spawnSync('sudo', [...sudoUserArgs(sudo), 'rm', '-f', '--', p], {
    stdio: 'inherit',
  });
  if (r.status !== 0 || r.error) {
    const detail = r.error
      ? r.error.message
      : `exit code ${r.status ?? 'unknown'}`;
    console.warn(`Warning: could not delete ${p}: ${detail}`);
    return false;
  }
  return true;
}

export function sudoFileExists(
  sudo: true | string,
  targetPath: string,
): boolean {
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'test', '-e', path.resolve(targetPath)],
    { stdio: 'ignore' },
  );
  if (r.error) throw new Error(`sudo test -e failed: ${r.error.message}`);
  return r.status === 0;
}

export function sudoIsSymlink(
  sudo: true | string,
  targetPath: string,
): boolean {
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'test', '-L', path.resolve(targetPath)],
    { stdio: 'ignore' },
  );
  if (r.error) throw new Error(`sudo test -L failed: ${r.error.message}`);
  return r.status === 0;
}

export function sudoRun(sudo: true | string, args: string[]): void {
  const r = spawnSync('sudo', [...sudoUserArgs(sudo), ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0 || r.error) {
    const detail = r.error
      ? r.error.message
      : `exit code ${r.status ?? 'unknown'}`;
    throw new Error(`sudo ${args.join(' ')} failed: ${detail}`);
  }
}

// Performs a privileged rename of src to dst. On Linux, GNU mv -T is used so
// mv refuses to move src *inside* dst when dst is a directory — preventing a
// TOCTOU race where dst is swapped for a directory after the precheck. BSD mv
// (macOS) does not support -T, so the flag is omitted on non-Linux platforms.
function sudoMv(sudo: true | string, src: string, dst: string): void {
  const atomicFlag = process.platform === 'linux' ? ['-T'] : [];
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'mv', ...atomicFlag, '--', src, dst],
    { stdio: 'inherit' },
  );
  if (r.status !== 0 || r.error) {
    const detail = r.error
      ? r.error.message
      : `exit code ${r.status ?? 'unknown'}`;
    throw new Error(`sudo mv failed for ${dst}: ${detail}`);
  }
}

// Returns the UID of the file/directory owner via sudo stat, trying GNU stat
// (-c %u) then BSD/macOS stat (-f %u). Returns undefined when the path does
// not exist or the UID cannot be determined.
function getSudoOwnerUid(
  sudo: true | string,
  targetPath: string,
): number | undefined {
  const absPath = path.resolve(targetPath);
  const gnu = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-L', '-c', '%u', '--', absPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (gnu.status === 0) {
    const uid = parseInt(gnu.stdout.toString().trim(), 10);
    if (!isNaN(uid)) return uid;
  }
  const bsd = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-f', '%u', absPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (bsd.status === 0) {
    const uid = parseInt(bsd.stdout.toString().trim(), 10);
    if (!isNaN(uid)) return uid;
  }
  return undefined;
}

// Returns the UID of the named OS user using `id -u`. Returns undefined when
// the user does not exist or the UID cannot be determined.
function getUserUid(username: string): number | undefined {
  const r = spawnSync('id', ['-u', username], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status === 0) {
    const uid = parseInt(r.stdout.toString().trim(), 10);
    if (!isNaN(uid)) return uid;
  }
  return undefined;
}

// Returns the set of UIDs that are trusted to own directories used as mktemp
// staging locations. Always includes root (0) and the invoking process's own
// UID — directories the caller already owns cannot be attacked by an outside
// party, since any "attack" would be the user racing their own process. For
// named-user sudo, the target user's UID is added so that directories owned
// by that user are also accepted.
function buildTrustedUids(sudo: true | string): Set<number> {
  const trusted = new Set<number>([0]);
  // process.getuid is not available on Windows; guard before calling.
  if (typeof process.getuid === 'function') trusted.add(process.getuid());
  if (typeof sudo === 'string') {
    const namedUid = getUserUid(sudo);
    if (namedUid !== undefined) trusted.add(namedUid);
  }
  return trusted;
}

// Returns the existing file's permission bits as an octal string via sudo stat,
// trying GNU stat (-c %a) then BSD/macOS stat (-f %Lp). Returns undefined when
// the file does not exist or the mode cannot be determined.
export function getSudoFileMode(
  sudo: true | string,
  targetPath: string,
): string | undefined {
  const absPath = path.resolve(targetPath); // ensure never starts with '-'
  const gnu = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-L', '-c', '%a', '--', absPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (gnu.status === 0) return gnu.stdout.toString().trim() || undefined;
  // BSD stat (macOS) does not support '--'; path.resolve() ensures no leading '-'
  const bsd = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-f', '%Lp', absPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (bsd.status === 0) return bsd.stdout.toString().trim() || undefined;
  return undefined;
}

// Verifies that a directory is safe to use as a mktemp staging location.
// Rejects directories that are group- or world-writable (mode & 0o022) because
// any member of the group or any local user could rename the just-created temp
// path to a symlink before the subsequent tee/cp opens it, redirecting the
// privileged write. When trustedUids is provided, also rejects directories
// whose owner UID is not in that set — the owner can always rename entries.
function checkDirSafe(
  sudo: true | string,
  absDir: string,
  trustedUids: Set<number> | undefined,
  label: string,
): void {
  const modeStr = getSudoFileMode(sudo, absDir);
  if (modeStr) {
    const mode = parseInt(modeStr, 8);
    if (!isNaN(mode) && mode & 0o022) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} is group- or world-writable; ` +
          `cannot safely create a temp file here (TOCTOU risk).`,
      );
    }
  }
  if (trustedUids !== undefined) {
    const ownerUid = getSudoOwnerUid(sudo, absDir);
    if (ownerUid !== undefined && !trustedUids.has(ownerUid)) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} is owned by UID ${ownerUid}, ` +
          `not a trusted identity; cannot safely create a temp file here (TOCTOU risk).`,
      );
    }
  }
}

// Walks every ancestor of targetPath (from the filesystem root down to its
// parent directory) and calls checkDirSafe on each. A single writable or
// untrusted-owned ancestor anywhere in the path is sufficient for a race:
// an attacker can swap that component to a symlink between the sudo preflight
// checks and the sudo mktemp/tee/mv, redirecting the privileged write.
function checkAncestorsSafe(
  sudo: true | string,
  targetPath: string,
  trustedUids: Set<number>,
  label: string,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break; // reached filesystem root
  }
  for (const ancestor of ancestors) {
    checkDirSafe(sudo, ancestor, trustedUids, `${label} ancestor`);
  }
}

function sudoWriteMv(t: SudoWriteTarget): void {
  const sudo = t.sudo;
  const dir = path.dirname(t.targetPath);

  // Build the trusted-UID set for this operation. Includes root (0), the
  // invoking user (who already owns the process and cannot be attacked by an
  // outside party when operating in their own dirs), and the named sudo target
  // user if applicable. This set is reused for all directory safety checks so
  // that the same ownership policy applies to both the staging dir and the
  // backup dir.
  const trustedUids = buildTrustedUids(sudo);

  // Validate existing ancestors BEFORE any privileged mkdir: creating root-owned
  // directories in an untrusted/world-writable path is itself a side effect that
  // must be prevented.
  checkAncestorsSafe(sudo, t.targetPath, trustedUids, 'destination');

  // Safe to create the destination directory now that all existing ancestors
  // have been validated.
  sudoRun(sudo, ['mkdir', '-p', '--', dir]);
  // Re-validate the full ancestor chain after mkdir: when mkdir -p created
  // intermediate directories, those new dirs were not covered by the pre-mkdir
  // checkAncestorsSafe above (they didn't exist then). Re-running it validates
  // every level, including any newly created intermediates and the final dir.
  checkAncestorsSafe(sudo, t.targetPath, trustedUids, 'destination');

  // Capture existing mode before writing so we can restore it after mv.
  // Explicit config mode wins; existing dest mode used as fallback.
  const existingMode = t.mode ? undefined : getSudoFileMode(sudo, t.targetPath);

  // Use sudo mktemp for exclusive O_EXCL creation — prevents symlink/hardlink tricks
  // if the destination directory is writable by other users.
  // path.resolve(dir) ensures the template is always an absolute path, so mktemp
  // never misinterprets it as an option (macOS mktemp doesn't support '--').
  const mktempResult = spawnSync(
    'sudo',
    [
      ...sudoUserArgs(sudo),
      'mktemp',
      path.join(path.resolve(dir), '.avanti-XXXXXXXXXX'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (mktempResult.status !== 0 || mktempResult.error) {
    const detail = mktempResult.error
      ? mktempResult.error.message
      : `exit code ${mktempResult.status ?? 'unknown'}`;
    throw new Error(`sudo mktemp failed in ${dir}: ${detail}`);
  }
  const tmpFile = mktempResult.stdout.toString().trim();
  let backupTmp: string | undefined;

  try {
    // No '--' before tmpFile: BSD tee(1) on macOS does not support '--', and
    // the mktemp-generated path is always absolute so it cannot start with '-'.
    const tee = spawnSync('sudo', [...sudoUserArgs(sudo), 'tee', tmpFile], {
      input: t.content,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    if (tee.status !== 0 || tee.error) {
      const detail = tee.error
        ? tee.error.message
        : `exit code ${tee.status ?? 'unknown'}`;
      throw new Error(`sudo write failed for ${t.targetPath}: ${detail}`);
    }

    if (t.backupPath) {
      const resolvedTarget = path.resolve(t.targetPath);
      const isSymlink = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-L', resolvedTarget],
        { stdio: 'ignore' },
      );
      const isFile =
        isSymlink.status !== 0 &&
        spawnSync(
          'sudo',
          [...sudoUserArgs(sudo), 'test', '-f', resolvedTarget],
          { stdio: 'ignore' },
        ).status === 0;
      if (isFile) {
        const backupDir = path.dirname(t.backupPath);
        // Validate backup ancestors BEFORE privileged mkdir to avoid creating
        // root-owned directories in an untrusted path.
        checkAncestorsSafe(sudo, t.backupPath, trustedUids, 'backup');
        sudoRun(sudo, ['mkdir', '-p', '--', backupDir]);
        // Re-validate the full backup ancestor chain after mkdir: intermediate
        // directories created by mkdir -p were not checked before (they didn't
        // exist). Re-running checkAncestorsSafe covers all levels including
        // newly created intermediates and the final backupDir.
        checkAncestorsSafe(sudo, t.backupPath, trustedUids, 'backup');
        // Use sudo mktemp so the backup temp is created with O_EXCL under
        // the privileged identity, preventing a symlink race in the backup
        // directory. path.resolve(backupDir) guarantees an absolute template.
        const mktempBackup = spawnSync(
          'sudo',
          [
            ...sudoUserArgs(sudo),
            'mktemp',
            path.join(path.resolve(backupDir), '.avanti-backup-XXXXXXXXXX'),
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        if (mktempBackup.status !== 0 || mktempBackup.error) {
          const detail = mktempBackup.error
            ? mktempBackup.error.message
            : `exit code ${mktempBackup.status ?? 'unknown'}`;
          throw new Error(`sudo mktemp failed in ${backupDir}: ${detail}`);
        }
        backupTmp = mktempBackup.stdout.toString().trim();
        // -p preserves the source file's mode bits on the backup copy.
        sudoRun(sudo, ['cp', '-p', '--', resolvedTarget, backupTmp]);
        const resolvedBackup = path.resolve(t.backupPath);
        // test -d follows symlinks, so this also catches symlinks-to-directories.
        // mv into a symlink-to-directory moves the file inside the directory rather
        // than replacing the symlink, which would silently write to the wrong place.
        const backupIsDir =
          spawnSync(
            'sudo',
            [...sudoUserArgs(sudo), 'test', '-d', resolvedBackup],
            { stdio: 'ignore' },
          ).status === 0;
        if (backupIsDir) {
          throw new Error(`backup path is a directory: ${t.backupPath}`);
        }
        sudoMv(sudo, backupTmp, resolvedBackup);
        backupTmp = undefined; // renamed into place — no cleanup needed
      }
    }

    const resolvedTarget = path.resolve(t.targetPath);
    const destIsSymlink =
      spawnSync('sudo', [...sudoUserArgs(sudo), 'test', '-L', resolvedTarget], {
        stdio: 'ignore',
      }).status === 0;
    if (destIsSymlink) {
      // Linux: sudoMv uses mv -T which atomically replaces any path including
      // symlinks — rename(2) is used directly, no pre-rm needed.
      // macOS/BSD: mv follows symlinks-to-directories and would move tmpFile
      // inside the symlink target instead of replacing the symlink. Pre-rm
      // only that case; symlinks-to-files are replaced atomically by rename(2).
      if (process.platform !== 'linux') {
        const destSymlinkIsDir =
          spawnSync(
            'sudo',
            [...sudoUserArgs(sudo), 'test', '-d', resolvedTarget],
            { stdio: 'ignore' },
          ).status === 0;
        if (destSymlinkIsDir) {
          sudoRun(sudo, ['rm', '-f', '--', resolvedTarget]);
        }
      }
    } else {
      // Only throw for a real directory (not through a symlink).
      const destIsDir =
        spawnSync(
          'sudo',
          [...sudoUserArgs(sudo), 'test', '-d', resolvedTarget],
          { stdio: 'ignore' },
        ).status === 0;
      if (destIsDir) {
        throw new Error(`target path is a directory: ${t.targetPath}`);
      }
    }
    sudoMv(sudo, tmpFile, resolvedTarget);

    // On non-Linux, mv lacks -T so it silently moves the temp file *inside* dst
    // if dst was swapped for a directory between the precheck and the rename.
    // Verify the target landed as a regular file to detect this race.
    if (process.platform !== 'linux') {
      const landed = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-f', resolvedTarget],
        { stdio: 'ignore' },
      );
      if (landed.status !== 0) {
        throw new Error(
          `sudo mv: file did not land at expected path ${t.targetPath} (destination may have been swapped)`,
        );
      }
    }

    // Apply mode: explicit config value wins; existing dest mode is used as fallback
    // for updates so sudo mv doesn't silently change permissions. For new files with
    // no explicit mode, derive from the process umask (0o666 & ~umask) so sudo and
    // non-sudo writes produce the same default permissions.
    // process.umask() is deprecated due to worker-thread race concerns; avanti is a
    // single-threaded CLI so the race does not apply.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mask = process.umask();
    const defaultMode = (0o666 & ~mask).toString(8).padStart(4, '0');
    const effectiveMode = t.mode ?? existingMode ?? defaultMode;
    sudoRun(sudo, ['chmod', '--', effectiveMode, resolvedTarget]);
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

function sudoWriteInPlace(t: SudoWriteTarget): void {
  const sudo = t.sudo;
  const dir = path.dirname(t.targetPath);

  // Validate ancestors BEFORE any privileged mkdir: creating root-owned
  // directories in an untrusted/world-writable path is itself a side effect
  // that must be prevented.
  //
  // Reject writeInPlace when any ancestor directory (from / down to dir) could
  // be raced. Checking only the immediate parent is insufficient: a symlink
  // anywhere in the path (e.g. /tmp/link/file where /tmp is world-writable)
  // can be swapped between the preflight checks and the sudo tee, redirecting
  // the privileged write. Validate every ancestor so that a world-writable or
  // untrusted directory anywhere in the path is detected and rejected.
  // Two checks per ancestor:
  // 1. Mode bits: group-write (0o020) or others-write (0o002) allow any member
  //    of the group or any local user to swap a component → reject.
  // 2. Owner UID: the directory owner can always modify its contents and could
  //    race even when group/other write bits are clear.
  //    Trusted UIDs: root (0), invoking user, and named sudo target user.
  // Use mv-style writes (writeInPlace: false) for targets in untrusted paths.
  const trustedUids = buildTrustedUids(sudo);
  // Collect every ancestor from / to dir (inclusive), without resolving
  // symlinks (path.resolve only canonicalises . and .., not symlink targets).
  const ancestors: string[] = [];
  let anc = path.resolve(t.targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break; // reached filesystem root
  }
  for (const ancestor of ancestors) {
    const ancModeStr = getSudoFileMode(sudo, ancestor);
    if (ancModeStr) {
      const ancMode = parseInt(ancModeStr, 8);
      if (!isNaN(ancMode) && ancMode & 0o022) {
        throw new Error(
          `writeInPlace: ancestor directory ${ancestor} is group- or world-writable; ` +
            `sudo writeInPlace cannot be used safely here due to TOCTOU risk. ` +
            `Remove writeInPlace: true to use atomic mv-style writes instead.`,
        );
      }
    }
    const ancOwnerUid = getSudoOwnerUid(sudo, ancestor);
    if (ancOwnerUid !== undefined && !trustedUids.has(ancOwnerUid)) {
      throw new Error(
        `writeInPlace: ancestor directory ${ancestor} is owned by UID ${ancOwnerUid}, ` +
          `not a trusted identity for this sudo operation; ` +
          `sudo writeInPlace cannot be used safely here due to TOCTOU risk. ` +
          `Remove writeInPlace: true to use atomic mv-style writes instead.`,
      );
    }
  }

  // Safe to create the destination directory now that all existing ancestors
  // have been validated.
  sudoRun(sudo, ['mkdir', '-p', '--', dir]);
  // Re-validate the full ancestor chain after mkdir: intermediate directories
  // created by mkdir -p were not covered by the pre-mkdir checkAncestorsSafe
  // (they didn't exist then). Re-running it validates all levels including
  // any newly created intermediates and the final destination directory.
  checkAncestorsSafe(sudo, t.targetPath, trustedUids, 'destination');

  let backupTmp: string | undefined;
  const resolvedTarget = path.resolve(t.targetPath);
  let preTeeMode: string | undefined;
  let modeApplied = false;

  try {
    if (t.backupPath) {
      const isSymlink = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-L', resolvedTarget],
        { stdio: 'ignore' },
      );
      const isFile =
        isSymlink.status !== 0 &&
        spawnSync(
          'sudo',
          [...sudoUserArgs(sudo), 'test', '-f', resolvedTarget],
          { stdio: 'ignore' },
        ).status === 0;
      if (isFile) {
        const backupDir = path.dirname(t.backupPath);
        // Validate backup ancestors BEFORE privileged mkdir.
        checkAncestorsSafe(sudo, t.backupPath, trustedUids, 'backup');
        sudoRun(sudo, ['mkdir', '-p', '--', backupDir]);
        // Re-validate the full backup ancestor chain after mkdir: intermediate
        // directories created by mkdir -p were not covered before (they didn't
        // exist). Re-running covers all levels including newly created
        // intermediates and the final backupDir.
        checkAncestorsSafe(sudo, t.backupPath, trustedUids, 'backup');
        // Use sudo mktemp for O_EXCL creation — prevents symlink race in backupDir.
        const mktempBackup = spawnSync(
          'sudo',
          [
            ...sudoUserArgs(sudo),
            'mktemp',
            path.join(path.resolve(backupDir), '.avanti-backup-XXXXXXXXXX'),
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        if (mktempBackup.status !== 0 || mktempBackup.error) {
          const detail = mktempBackup.error
            ? mktempBackup.error.message
            : `exit code ${mktempBackup.status ?? 'unknown'}`;
          throw new Error(`sudo mktemp failed in ${backupDir}: ${detail}`);
        }
        backupTmp = mktempBackup.stdout.toString().trim();
        // -p preserves the source file's mode bits on the backup copy.
        sudoRun(sudo, ['cp', '-p', '--', resolvedTarget, backupTmp]);
        const resolvedBackup = path.resolve(t.backupPath);
        // test -d follows symlinks, so this also catches symlinks-to-directories.
        // mv into a symlink-to-directory moves the file inside the directory rather
        // than replacing the symlink, which would silently write to the wrong place.
        const backupIsDir =
          spawnSync(
            'sudo',
            [...sudoUserArgs(sudo), 'test', '-d', resolvedBackup],
            { stdio: 'ignore' },
          ).status === 0;
        if (backupIsDir) {
          throw new Error(`backup path is a directory: ${t.backupPath}`);
        }
        sudoMv(sudo, backupTmp, resolvedBackup);
        backupTmp = undefined;
      }
    }

    // Refuse symlinks (sudo tee would follow them to an unintended target)
    // and refuse non-regular files (FIFOs, devices, sockets), mirroring the
    // non-sudo writeInPlace path.
    const symlinkCheck = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'test', '-L', resolvedTarget],
      { stdio: 'ignore' },
    );
    if (symlinkCheck.status === 0) {
      throw new Error(
        `writeInPlace: ${t.targetPath} is a symlink; refusing to follow`,
      );
    }
    const existsCheck = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'test', '-e', resolvedTarget],
      { stdio: 'ignore' },
    );
    if (existsCheck.status === 0) {
      const regularCheck = spawnSync(
        'sudo',
        [...sudoUserArgs(sudo), 'test', '-f', resolvedTarget],
        { stdio: 'ignore' },
      );
      if (regularCheck.status !== 0) {
        throw new Error(
          `writeInPlace: ${t.targetPath} is not a regular file; refusing to write`,
        );
      }
    }

    const isNewFile = existsCheck.status !== 0;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mask = process.umask();
    const defaultMode = (0o666 & ~mask).toString(8).padStart(4, '0');
    const effectiveMode = t.mode ?? (isNewFile ? defaultMode : undefined);

    if (isNewFile && effectiveMode !== undefined) {
      // Pre-create with an owner-writable mode so tee can write regardless of
      // the requested final mode. Using the final mode directly would break
      // named-user (sudo:"user") writes when that mode removes the write bit
      // (e.g. 0400 or 0444): install creates the file then the subsequent
      // sudo -u user tee cannot open it for writing. Creating with 0600 keeps
      // the window minimal (only owner can read/write during the tee phase)
      // while ensuring tee always succeeds. The final mode is applied after.
      // resolvedTarget is always absolute so no '--' needed after '-m'.
      sudoRun(sudo, ['install', '-m', '0600', '/dev/null', resolvedTarget]);
    }

    // For existing files, temporarily ensure owner-write so tee can open the
    // file even when its current mode has no write bit (e.g. 0400/0444 set on
    // a previous pull). For named-user sudo, chmod u+w may fail when the target
    // file is owned by a different account (e.g. root:www-data 0664 — www-data
    // can write via group bit but is not the owner and cannot chmod). In that
    // case proceed without chmod; tee will fail here too if the write is
    // actually forbidden. Only set preTeeMode when chmod succeeded so the
    // finally block knows to restore the original mode only when it was changed.
    if (!isNewFile) {
      const capturedMode = getSudoFileMode(sudo, resolvedTarget);
      try {
        sudoRun(sudo, ['chmod', 'u+w', '--', resolvedTarget]);
        preTeeMode = capturedMode; // only set when chmod succeeded
      } catch {
        // chmod u+w failed (not owner) — proceed; tee will fail if write is
        // also forbidden. preTeeMode remains undefined (nothing to restore).
      }
    }

    // No '--' before resolvedTarget: BSD tee(1) on macOS does not support '--',
    // and the path is always absolute (path.resolve) so it cannot start with '-'.
    const tee = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), 'tee', resolvedTarget],
      { input: t.content, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    if (tee.status !== 0 || tee.error) {
      const detail = tee.error
        ? tee.error.message
        : `exit code ${tee.status ?? 'unknown'}`;
      throw new Error(`sudo write failed for ${t.targetPath}: ${detail}`);
    }

    // Apply mode AFTER tee. effectiveMode wins; fall back to the captured
    // pre-tee mode when no explicit mode is configured (undoes the u+w chmod).
    if (effectiveMode !== undefined) {
      sudoRun(sudo, ['chmod', '--', effectiveMode, resolvedTarget]);
      modeApplied = true;
    } else if (preTeeMode !== undefined) {
      sudoRun(sudo, ['chmod', '--', preTeeMode, resolvedTarget]);
      modeApplied = true;
    }
  } finally {
    // If tee threw before modeApplied was set, restore the pre-tee mode so
    // the file does not stay more permissive after a failed pull.
    if (preTeeMode !== undefined && !modeApplied) {
      try {
        sudoRun(sudo, ['chmod', '--', preTeeMode, resolvedTarget]);
      } catch {
        // best-effort mode restore
      }
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

export function atomicWrite(
  targets: WriteTarget[],
  deletions: string[] = [],
): void {
  // Stage each file as a sibling temp file on the same filesystem as the
  // destination so that renameSync (rename(2)) is atomic on POSIX.
  const symlinkTargets = targets.filter((t) => t.symlinkTarget !== undefined);
  const regularTargets = targets.filter((t) => t.symlinkTarget === undefined);
  const mvTargets = regularTargets.filter((t) => !t.writeInPlace);
  const inPlaceTargets = regularTargets.filter((t) => t.writeInPlace);

  const staged: Array<{ tmp: string; dest: string; effectiveMode?: number }> =
    [];
  const backupTemps: string[] = [];
  const tmpLinks: string[] = [];
  try {
    // Symlink phase: create atomically via temp symlink + rename(2).
    // rename(2) is atomic on POSIX even when the destination already exists.
    for (const t of symlinkTargets) {
      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpLink = path.join(
        dir,
        '.' +
          path.basename(t.targetPath) +
          '.' +
          crypto.randomBytes(8).toString('hex') +
          '.avanti-tmp',
      );
      tmpLinks.push(tmpLink);
      fs.symlinkSync(t.symlinkTarget!, tmpLink);
      fs.renameSync(tmpLink, t.targetPath);
      tmpLinks.pop(); // rename succeeded — no longer needs cleanup
    }
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
      if (!t.backupPath) continue;
      const existing = fs.lstatSync(t.targetPath, { throwIfNoEntry: false });
      if (!existing?.isFile() && !existing?.isSymbolicLink()) continue;
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
      if (existing.isSymbolicLink()) {
        // Preserve the symlink itself (not the file it points to) in the backup.
        fs.symlinkSync(fs.readlinkSync(t.targetPath), backupTmp);
      } else {
        fs.copyFileSync(t.targetPath, backupTmp);
      }
      backupRenames.push({ tmp: backupTmp, dest: t.backupPath });
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
    for (const tmp of tmpLinks) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // already renamed into place or never created
      }
    }
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
