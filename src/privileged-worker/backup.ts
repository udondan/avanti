/** Backups of the current target (regular file or symlink) before a write. */
import * as fs from 'fs';
import * as path from 'path';
import { mkdirWithAncestorChecks } from './ancestors';
import {
  O_NOFOLLOW,
  closeQuietly,
  errnoCode,
  isAbsentOrNotFile,
  randomHex,
  refuseDirectory,
  safeFchmodSync,
  unlinkQuietly,
} from './fs-helpers';

interface BackupDestination {
  resolvedBackup: string;
  backupTmp: string;
}

// Refuses a directory at the backup path, creates its parent directory (with
// ancestor checks) and picks an O_EXCL staging name next to it.
function prepareBackupDestination(
  backupPath: string,
  trustedUids: Set<number> | undefined,
): BackupDestination {
  const resolvedBackup = path.resolve(backupPath);
  const backupDir = path.dirname(resolvedBackup);

  // Refuse if backup destination is a directory.
  refuseDirectory(resolvedBackup, `backup path is a directory: ${backupPath}`);

  // Pre-validate before mkdirSync so we catch world-writable ancestors that
  // the caller could not lstat (EACCES); re-validate after to cover any
  // intermediate directories that mkdirSync itself creates.
  mkdirWithAncestorChecks(resolvedBackup, backupDir, trustedUids, 'backup');

  const backupTmp = path.join(
    path.resolve(backupDir),
    `.avanti-backup-${randomHex()}`,
  );
  return { resolvedBackup, backupTmp };
}

// Open fds and the staging file owned by backupRegularFile; cleaned up on error.
interface RegularBackupState {
  sfd?: number;
  bfd?: number;
  createdTmp?: string;
}

function copyFd(sfd: number, bfd: number): void {
  const buf = Buffer.alloc(65536);
  let bytesRead: number;
  while ((bytesRead = fs.readSync(sfd, buf, 0, buf.length, null)) > 0) {
    fs.writeSync(bfd, buf, 0, bytesRead);
  }
}

function writeRegularBackup(
  sfd: number,
  state: RegularBackupState,
  backupPath: string,
  trustedUids: Set<number> | undefined,
): void {
  const srcStat = fs.fstatSync(sfd);
  if (!srcStat.isFile()) {
    fs.closeSync(sfd);
    state.sfd = undefined;
    return;
  }

  const { resolvedBackup, backupTmp } = prepareBackupDestination(
    backupPath,
    trustedUids,
  );

  // O_EXCL creation — prevents TOCTOU in the backup staging directory. Keep
  // the fd open and write through it so no path-based TOCTOU window opens
  // between open and write.
  const bfd = fs.openSync(backupTmp, 'wx', 0o600);
  state.bfd = bfd;
  // Only unlink backupTmp when WE created it. bfd tracks the open fd, but
  // it is cleared before renameSync — if rename fails, bfd is already
  // undefined even though we own the temp file. Track the file separately.
  state.createdTmp = backupTmp;
  copyFd(sfd, bfd);
  safeFchmodSync(bfd, srcStat.mode & 0o7777);
  fs.closeSync(bfd);
  state.bfd = undefined;
  fs.closeSync(sfd);
  state.sfd = undefined;
  fs.renameSync(backupTmp, resolvedBackup);
}

export function backupRegularFile(
  targetPath: string,
  backupPath: string,
  trustedUids?: Set<number>,
): void {
  // Open the source first with O_NOFOLLOW so the isFile check is on the same
  // fd that will be read — eliminates the TOCTOU window between lstatSync and
  // openSync where a symlink swap could silently skip the backup.
  // O_NOFOLLOW: ELOOP if targetPath is a symlink (→ not a regular file, skip).
  // O_NONBLOCK omitted: the subsequent readSync can return EAGAIN on NFS/FUSE
  // when O_NONBLOCK is set. The fstatSync check below rejects non-regular
  // files (FIFOs, sockets) before any read is attempted.
  let sfd: number;
  try {
    sfd = fs.openSync(targetPath, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (isAbsentOrNotFile(errnoCode(e))) return;
    throw e;
  }

  const state: RegularBackupState = { sfd };
  try {
    writeRegularBackup(sfd, state, backupPath, trustedUids);
  } catch (err) {
    closeQuietly(state.bfd);
    if (state.createdTmp !== undefined) unlinkQuietly(state.createdTmp);
    closeQuietly(state.sfd);
    throw err;
  }
}

function backupSymlink(
  targetPath: string,
  backupPath: string,
  trustedUids: Set<number> | undefined,
  rawTarget: string,
): void {
  const { resolvedBackup, backupTmp } = prepareBackupDestination(
    backupPath,
    trustedUids,
  );
  try {
    // Convert relative targets to absolute so the backup is self-contained at
    // its storage location (user-defined via `backup:`, not necessarily the same
    // directory as the original file). Matches the unprivileged path in writer.ts.
    const linkTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(targetPath), rawTarget);
    fs.symlinkSync(linkTarget, backupTmp);
    fs.renameSync(backupTmp, resolvedBackup);
  } catch (err) {
    unlinkQuietly(backupTmp);
    throw err;
  }
}

interface BackupTargetOptions {
  targetPath: string;
  backupPath: string;
  lst: fs.Stats | undefined;
  trustedUids?: Set<number>;
  // Pre-read link target: callers MUST pass the readlinkSync result obtained
  // immediately after their lstatSync to avoid a TOCTOU window between the
  // isSymbolicLink() check and a second readlinkSync here. Required (not
  // optional) when lst.isSymbolicLink() is true — omitting it is an invariant
  // violation and will throw.
  preobtainedLinkTarget?: string;
}

// Backs up whatever currently lives at targetPath (regular file or symlink).
// No-op if targetPath does not exist or is a directory (directories are refused
// upstream before we reach the backup step).
export function backupTarget(opts: BackupTargetOptions): void {
  const { targetPath, backupPath, lst, trustedUids } = opts;
  if (lst === undefined) return;

  if (lst.isSymbolicLink()) {
    if (opts.preobtainedLinkTarget === undefined) {
      throw new Error(
        'internal: preobtainedLinkTarget must be provided when backing up a symlink',
      );
    }
    // Use the pre-obtained link target to avoid a TOCTOU window between the
    // caller's isSymbolicLink() check and reading the target here.
    backupSymlink(
      targetPath,
      backupPath,
      trustedUids,
      opts.preobtainedLinkTarget,
    );
  } else if (lst.isFile()) {
    backupRegularFile(targetPath, backupPath, trustedUids);
  }
}

interface ExistingTarget {
  lst?: fs.Stats;
  linkTarget?: string;
}

/**
 * lstats the current target for a later backupTarget call: absent → empty
 * result; a real directory → throws directoryError. For a symlink, the link
 * target is read immediately alongside lstat to minimise the TOCTOU window
 * before passing it to backupTarget.
 */
export function inspectExistingTarget(
  resolvedTarget: string,
  directoryError: string,
): ExistingTarget {
  const found: ExistingTarget = {};
  try {
    const lst = fs.lstatSync(resolvedTarget);
    found.lst = lst;
    if (!lst.isSymbolicLink() && lst.isDirectory()) {
      throw new Error(directoryError);
    }
    if (lst.isSymbolicLink()) {
      found.linkTarget = fs.readlinkSync(resolvedTarget);
    }
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e;
  }
  return found;
}

// Removes a backup whose write never committed; the original is still intact.
export function removeOrphanedBackup(backupPath: string): void {
  unlinkQuietly(path.resolve(backupPath));
}
