/** atomicWrite phases 0–2: stage temp symlinks and files, then create backups. */
import * as fs from 'fs';
import * as path from 'path';
import { parseMode } from '../privileged-worker';
import {
  createUniqueTemp,
  ensureDir,
  openFlag,
  randomTempPath,
  writeAll,
} from './fs-utils';
import type { WriteTarget } from './types';

export type SymlinkWriteTarget = WriteTarget & { symlinkTarget: string };

export interface StagedFile {
  tmp: string;
  dest: string;
  effectiveMode?: number;
}

export interface StagedLink {
  tmp: string;
  dest: string;
}

// Phase 0 (symlink staging): creates a temp symlink next to the destination
// but does NOT rename it yet. Renames happen in Phase 3, after backups have
// captured the pre-write state.
export function stageSymlink(t: SymlinkWriteTarget): StagedLink {
  const dir = path.dirname(t.targetPath);
  ensureDir(dir);
  // Retry on collision — same strategy as O_EXCL temp files.
  const tmpLink = createUniqueTemp(
    dir,
    path.basename(t.targetPath),
    '.avanti-tmp',
    (tmp) => fs.symlinkSync(t.symlinkTarget, tmp),
  );
  return { tmp: tmpLink, dest: t.targetPath };
}

// Phase 1 (mv targets): writes the temp file for t. The entry is pushed onto
// staged before any content is written so the caller's cleanup removes it.
export function stageFile(t: WriteTarget, staged: StagedFile[]): void {
  const dir = path.dirname(t.targetPath);
  ensureDir(dir);
  const tmpFile = randomTempPath(
    dir,
    path.basename(t.targetPath),
    '.avanti-tmp',
  );
  // O_CREAT|O_EXCL rejects any pre-existing entry at this path (including
  // symlinks — POSIX guarantees EEXIST when O_EXCL is set and the path
  // resolves to a symlink). O_NOFOLLOW is belt-and-suspenders on POSIX.
  // The random suffix makes pre-creation attacks impractical regardless.
  const tmpFd = fs.openSync(
    tmpFile,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      openFlag('O_NOFOLLOW'),
    0o666,
  );
  // Register for cleanup before the write so a writeSync failure (e.g.
  // ENOSPC) doesn't leave an orphan .avanti-tmp in the target directory.
  const stagingEntry: StagedFile = {
    tmp: tmpFile,
    dest: t.targetPath,
  };
  staged.push(stagingEntry);

  // Resolve effective mode before writing so we can apply fchmodSync via
  // the fd while it is still open, eliminating the TOCTOU window that a
  // path-based chmodSync after renameSync would create.
  const effectiveMode = stagedFileMode(t);
  stagingEntry.effectiveMode = effectiveMode;

  try {
    writeAll(tmpFd, t.content);
    // Apply mode via fd while it is still open — sets permissions on the
    // inode without re-traversing the path (no TOCTOU between rename and chmod).
    if (effectiveMode !== undefined) {
      fs.fchmodSync(tmpFd, effectiveMode);
    }
  } finally {
    fs.closeSync(tmpFd);
  }
}

function stagedFileMode(t: WriteTarget): number | undefined {
  if (t.mode) return parseMode(t.mode);
  try {
    return fs.lstatSync(t.targetPath).mode & 0o7777;
  } catch {
    // file doesn't exist yet — leave the temp file's umask permissions
    return undefined;
  }
}

// Pre-validate writeInPlace targets before Phase 2: if any is a symlink,
// Phase 4 will refuse to write through it. Fail early so no backup is
// created for a write that will never proceed.
export function assertInPlaceTargetsNotSymlinks(
  inPlaceTargets: WriteTarget[],
): void {
  for (const t of inPlaceTargets) {
    const entry = fs.lstatSync(t.targetPath, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      throw new Error(
        `writeInPlace: ${t.targetPath} is a symlink; refusing to follow`,
      );
    }
  }
}

// Phase 2: all staging succeeded — now create backups.
// Phase 2a: copy each source file to a uniquely-named temp in the backup
// dir. If any copy fails, no backup destination has been touched yet.
// Every created temp is pushed onto backupTemps for the caller's cleanup.
export function createBackups(
  targets: WriteTarget[],
  backupTemps: string[],
): void {
  const backupRenames: Array<{ tmp: string; dest: string }> = [];
  for (const t of targets) {
    if (!t.backupPath) continue;
    const backupTmp = stageBackup(t.targetPath, t.backupPath);
    if (backupTmp === undefined) continue;
    backupTemps.push(backupTmp);
    backupRenames.push({ tmp: backupTmp, dest: t.backupPath });
  }
  // Phase 2b: all copies succeeded — rename each backup temp into place.
  for (const { tmp, dest } of backupRenames) {
    fs.renameSync(tmp, dest);
  }
}

// Copies targetPath to a backup temp next to backupPath and returns the temp
// path, or undefined when there is nothing to back up.
function stageBackup(
  targetPath: string,
  backupPath: string,
): string | undefined {
  const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!existing) return undefined;
  const isSymlink = existing.isSymbolicLink();
  if (!existing.isFile() && !isSymlink) return undefined;
  if (isSymlink && process.platform === 'win32') {
    // fs.symlinkSync requires elevated privileges on Windows; copyFileSync
    // would dereference the link and copy its target's contents, which is
    // misleading and can read files outside the working directory. Skip
    // before creating backupDir so no empty directory is left behind.
    console.warn(
      `Warning: cannot back up symlink ${targetPath} on Windows; backup skipped.`,
    );
    return undefined;
  }
  const backupDir = path.dirname(backupPath);
  ensureDir(backupDir);
  // Copy via a uniquely-named temp file then rename so that:
  // (a) a symlink at backupPath is replaced, not followed, and
  // (b) a predictable temp path cannot be pre-created as a symlink.
  const baseName = path.basename(backupPath);
  if (isSymlink) {
    // Preserve the symlink itself (not the file it points to) in the backup.
    // Resolve relative targets to absolute so the backup symlink resolves
    // correctly from backupDir, not just from the original link's directory.
    const rawLinkTarget = fs.readlinkSync(targetPath);
    const absLinkTarget = path.isAbsolute(rawLinkTarget)
      ? rawLinkTarget
      : path.resolve(path.dirname(targetPath), rawLinkTarget);
    // Retry on EEXIST — same strategy as the symlink staging loop (Phase 0).
    return createUniqueTemp(backupDir, baseName, '.avanti-backup-tmp', (tmp) =>
      fs.symlinkSync(absLinkTarget, tmp),
    );
  }
  return createUniqueTemp(backupDir, baseName, '.avanti-backup-tmp', (tmp) => {
    try {
      fs.copyFileSync(targetPath, tmp, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // copyFileSync may have created a partial file before failing
        // (e.g. ENOSPC, I/O error). Remove it so no orphan is left.
        fs.rmSync(tmp, { force: true });
      }
      throw err;
    }
  });
}
