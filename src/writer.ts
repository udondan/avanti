import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { WriteOp } from './privileged-worker';

export interface SudoChmodTarget {
  targetPath: string;
  mode: string;
  sudo: true | string;
}

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

function runPrivilegedWorker(
  sudo: true | string,
  ops: WriteOp[],
  continueOnError = false,
): Array<{ ok: boolean; error?: string }> {
  if (process.platform === 'win32') {
    throw new Error('sudo is not supported on Windows');
  }
  // When running via tsx (TypeScript source, __filename ends in .ts), the
  // compiled worker is one level up in dist/. In production (dist/writer.js),
  // the worker is a sibling.
  const workerPath = __filename.endsWith('.ts')
    ? path.resolve(__dirname, '..', 'dist', 'privileged-worker.js')
    : path.join(__dirname, 'privileged-worker.js');

  let resolvedWorkerPath = workerPath;
  // Named-user sudo: if process.execPath lives inside the calling user's home
  // directory (e.g. nvm/asdf/mise installs), the target sudo user cannot
  // traverse that directory (mode 0700/0750) and will get EACCES when exec-ing
  // the Node binary. Fall back to the system 'node' on PATH in that case, which
  // is guaranteed to be world-executable. Root sudo always has access, so
  // process.execPath is always preferred there to avoid runtime version mismatches.
  const nodeExec =
    typeof sudo === 'string' &&
    process.execPath.startsWith(os.homedir() + path.sep)
      ? path.basename(process.execPath)
      : process.execPath;
  let cleanup: (() => void) | undefined;

  if (typeof sudo === 'string' && fs.existsSync(workerPath)) {
    // Named-user sudo: the target user may not be able to read the worker
    // from a private project directory. Copy it to a world-readable temp
    // path so sudo -u <user> can exec it.
    // Use a private subdirectory so the worker file cannot be swapped out by
    // another unprivileged process between the copy and the sudo exec.
    // os.tmpdir() may return a per-user private path on macOS (e.g.
    // /var/folders/…) whose ancestor directories are not world-traversable,
    // so the named sudo user cannot reach the worker. /tmp is always
    // world-executable on Unix (sticky 01777); fall back to os.tmpdir() only
    // on Windows where /tmp is not a standard path.
    const tmpWorkerDir = path.join(
      '/tmp',
      `.avanti-worker-${crypto.randomBytes(5).toString('hex')}`,
    );
    fs.mkdirSync(tmpWorkerDir, { mode: 0o755 });
    cleanup = () => {
      try {
        fs.rmSync(tmpWorkerDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    };
    // mkdirSync mode is masked by the caller's umask (e.g. 077 → 0700), which
    // would prevent the named sudo user from traversing this directory. Chmod
    // explicitly to ensure the directory is always world-executable.
    fs.chmodSync(tmpWorkerDir, 0o755);
    const tmpWorker = path.join(tmpWorkerDir, 'privileged-worker.js');
    fs.copyFileSync(workerPath, tmpWorker);
    fs.chmodSync(tmpWorker, 0o644);
    resolvedWorkerPath = tmpWorker;
  }

  let result;
  try {
    result = spawnSync(
      'sudo',
      [...sudoUserArgs(sudo), nodeExec, resolvedWorkerPath],
      {
        input: JSON.stringify({
          ops,
          trustedUids: [...buildTrustedUids(sudo)],
          continueOnError: continueOnError || undefined,
        }),
        stdio: ['pipe', 'pipe', 'inherit'],
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } finally {
    cleanup?.();
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    let workerError =
      result.status === null
        ? `privileged worker terminated by signal ${result.signal}`
        : `privileged worker failed (exit ${result.status})`;
    try {
      if (result.stdout) {
        const parsed = JSON.parse(result.stdout) as {
          results: Array<{ ok: boolean; error?: string }>;
        };
        const failedResult = parsed.results?.find((r) => !r.ok);
        if (failedResult?.error) {
          workerError = failedResult.error;
        }
      }
    } catch {
      // ignore JSON parse failure; use the generic message
    }
    throw new Error(workerError);
  }
  let results: Array<{ ok: boolean; error?: string }>;
  try {
    const parsed = JSON.parse(result.stdout) as {
      results: Array<{ ok: boolean; error?: string }>;
    };
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error(
        `privileged worker returned malformed response (missing results array): ${result.stdout}`,
      );
    }
    results = parsed.results;
  } catch (e) {
    throw new Error(
      `privileged worker returned non-JSON output: ${result.stdout}`,
      { cause: e },
    );
  }
  if (!continueOnError) {
    for (const r of results) {
      if (!r.ok) throw new Error(r.error ?? 'privileged worker op failed');
    }
  }
  return results;
}

// Each target is written atomically inside the privileged worker process, but
// the batch is NOT collectively atomic: a failure mid-way leaves earlier targets
// already written. All targets sharing the same sudo identity are dispatched in
// a single worker invocation — one sudo password prompt per distinct identity.
export function sudoAtomicWrite(targets: SudoWriteTarget[]): void {
  if (targets.length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const mask = process.umask();
  const defaultMode = (0o666 & ~mask).toString(8).padStart(4, '0');

  // Validate ancestor safety for all targets before any privileged work.
  // checkAncestorsSafe prefers lstatSync (0 sudo calls) for world-readable
  // paths like /usr/local/bin; sudo stat is only used for unreadable ancestors.
  const checkedDirsBySudo = new Map<true | string, Set<string>>();
  for (const t of targets) {
    const trustedUids = buildTrustedUids(t.sudo);
    if (!checkedDirsBySudo.has(t.sudo))
      checkedDirsBySudo.set(t.sudo, new Set());
    const checkedDirs = checkedDirsBySudo.get(t.sudo)!;
    checkAncestorsSafe(
      t.sudo,
      t.targetPath,
      trustedUids,
      'destination',
      checkedDirs,
    );
    if (t.backupPath) {
      checkAncestorsSafe(
        t.sudo,
        t.backupPath,
        trustedUids,
        'backup',
        checkedDirs,
      );
    }
  }

  // Encode content as base64 in the JSON payload — no temp files needed.
  // This works for any sudo identity (root, named user) since the data travels
  // over stdin and the worker never touches the caller's filesystem.
  const targetOps: Array<{ sudo: true | string; op: WriteOp }> = [];

  for (const t of targets) {
    if (t.symlinkTarget !== undefined) {
      targetOps.push({
        sudo: t.sudo,
        op: {
          type: 'write-symlink',
          targetPath: t.targetPath,
          symlinkTarget: t.symlinkTarget,
          backupPath: t.backupPath,
        },
      });
    } else {
      const contentB64 = t.content.toString('base64');
      targetOps.push({
        sudo: t.sudo,
        op: t.writeInPlace
          ? {
              type: 'write-in-place',
              targetPath: t.targetPath,
              contentB64,
              mode: t.mode,
              defaultMode,
              backupPath: t.backupPath,
            }
          : {
              type: 'write-mv',
              targetPath: t.targetPath,
              contentB64,
              mode: t.mode,
              defaultMode,
              backupPath: t.backupPath,
            },
      });
    }
  }

  // Group ops by sudo identity; one worker invocation per group.
  const groups = new Map<true | string, WriteOp[]>();
  for (const { sudo, op } of targetOps) {
    const existing = groups.get(sudo);
    if (existing) {
      existing.push(op);
    } else {
      groups.set(sudo, [op]);
    }
  }
  for (const [sudo, ops] of groups) {
    runPrivilegedWorker(sudo, ops);
  }
}

// Batches privileged mode-only changes into one worker invocation per sudo identity.
export function sudoAtomicChmod(targets: SudoChmodTarget[]): void {
  if (targets.length === 0) return;
  const groups = new Map<true | string, WriteOp[]>();
  for (const t of targets) {
    const op: WriteOp = {
      type: 'chmod',
      targetPath: t.targetPath,
      mode: t.mode,
    };
    const existing = groups.get(t.sudo);
    if (existing) {
      existing.push(op);
    } else {
      groups.set(t.sudo, [op]);
    }
  }
  for (const [sudo, ops] of groups) {
    runPrivilegedWorker(sudo, ops);
  }
}

// Batches privileged deletions into one worker invocation per sudo identity.
// Returns the set of paths that were successfully deleted.
// When bestEffort is false (default), worker-level failures throw; individual
// per-path failures also throw. When bestEffort is true, both are warned and
// the partial success set is returned — used by pull's stale-file cleanup.
export function sudoAtomicDelete(
  deletions: Array<[string, true | string]>,
  bestEffort = false,
): Set<string> {
  const succeeded = new Set<string>();
  if (deletions.length === 0) return succeeded;
  // Track per-sudo ordered path lists to correlate results with paths.
  const groups = new Map<true | string, string[]>();
  for (const [p, sudo] of deletions) {
    const existing = groups.get(sudo);
    if (existing) {
      existing.push(p);
    } else {
      groups.set(sudo, [p]);
    }
  }
  for (const [sudo, paths] of groups) {
    const ops: WriteOp[] = paths.map((p) => ({
      type: 'delete',
      targetPath: p,
    }));
    try {
      const results = runPrivilegedWorker(sudo, ops, true);
      const failed: string[] = [];
      results.forEach((r, i) => {
        if (r.ok) {
          succeeded.add(paths[i]);
        } else if (bestEffort) {
          console.warn(
            `Warning: privileged operation failed: ${r.error ?? 'unknown error'}`,
          );
        } else {
          failed.push(`${paths[i]}: ${r.error ?? 'unknown error'}`);
        }
      });
      if (failed.length > 0) {
        throw new Error(`privileged deletion failed:\n${failed.join('\n')}`);
      }
    } catch (err) {
      if (bestEffort) {
        console.warn(
          `Warning: privileged deletion worker failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        throw err;
      }
    }
  }
  return succeeded;
}

export function sudoRead(sudo: true | string, filePath: string): Buffer | null {
  // Use sudo cat with piped stdout — no temp file, no world-writable surface,
  // no TOCTOU. maxBuffer is set high enough to cover any config file avanti
  // would manage (individual config files are always well under 100 MB).
  const absPath = path.resolve(filePath);
  const result = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'cat', '--', absPath],
    { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024 },
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

export function sudoFileExists(
  sudo: true | string,
  targetPath: string,
): boolean {
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'test', '-e', path.resolve(targetPath)],
    { stdio: ['inherit', 'ignore', 'ignore'] },
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
    { stdio: ['inherit', 'ignore', 'ignore'] },
  );
  if (r.error) throw new Error(`sudo test -L failed: ${r.error.message}`);
  return r.status === 0;
}

export function sudoIsDirectory(
  sudo: true | string,
  targetPath: string,
): boolean {
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'test', '-d', path.resolve(targetPath)],
    { stdio: ['inherit', 'ignore', 'ignore'] },
  );
  if (r.error) throw new Error(`sudo test -d failed: ${r.error.message}`);
  return r.status === 0;
}

export function sudoReadlink(
  sudo: true | string,
  targetPath: string,
): string | null {
  const r = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'readlink', path.resolve(targetPath)],
    { stdio: ['inherit', 'pipe', 'ignore'] },
  );
  if (r.error) throw new Error(`sudo readlink failed: ${r.error.message}`);
  if (r.status !== 0) return null;
  return r.stdout.toString().trim();
}

// Performs a privileged rename of src to dst. On Linux, GNU mv -T is used so
// mv refuses to move src *inside* dst when dst is a directory — preventing a
// TOCTOU race where dst is swapped for a directory after the precheck. BSD mv
// (macOS) does not support -T, so the flag is omitted on non-Linux platforms.

// Returns the UID of the file/directory owner via sudo stat, trying GNU stat
// (-c %u) then BSD/macOS stat (-f %u). Returns undefined when the path does
// not exist or the UID cannot be determined.
function getSudoOwnerUid(
  sudo: true | string,
  targetPath: string,
  followSymlink = false,
): number | undefined {
  const absPath = path.resolve(targetPath);
  // By default do NOT use -L: the caller may need the symlink's own UID, not
  // its target's UID (the symlink owner can rename the link regardless of the
  // parent's sticky bit, so checking the target UID would create a security
  // bypass). Pass followSymlink=true when the caller specifically needs the
  // target directory's owner (e.g. when stat failed with EACCES and we need
  // to verify the target dir owner via sudo).
  const gnuArgs = followSymlink
    ? [...sudoUserArgs(sudo), 'stat', '-L', '-c', '%u', '--', absPath]
    : [...sudoUserArgs(sudo), 'stat', '-c', '%u', '--', absPath];
  // stdin: 'inherit' passes the parent's fd 0 to the child. stat(1) never
  // reads stdin, so this is safe. On macOS, sudo locates cached credentials by
  // TTY name from fd 0; 'ignore' (non-TTY /dev/null) breaks that lookup and
  // causes a re-prompt. 'inherit' preserves the TTY in interactive sessions and
  // degrades gracefully (non-TTY) in CI/daemon contexts.
  const gnu = spawnSync('sudo', gnuArgs, {
    stdio: ['inherit', 'pipe', 'ignore'],
  });
  if (gnu.status === 0) {
    const uid = parseInt(gnu.stdout.toString().trim(), 10);
    if (!isNaN(uid)) return uid;
  }
  // BSD stat follows symlinks by default (without any flag). Use -h to lstat
  // the symlink itself when followSymlink is false; -L to explicitly follow.
  const bsdArgs = followSymlink
    ? [...sudoUserArgs(sudo), 'stat', '-L', '-f', '%u', absPath]
    : [...sudoUserArgs(sudo), 'stat', '-h', '-f', '%u', absPath];
  const bsd = spawnSync('sudo', bsdArgs, {
    stdio: ['inherit', 'pipe', 'ignore'],
  });
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
// trying GNU stat (-L -c %a) then BSD/macOS stat (-L -f %Lp). Both use -L to
// follow symlinks — the caller wants the target directory's mode, not the
// symlink's own permissions. Returns undefined when the file does not exist or
// the mode cannot be determined.
export function getSudoFileMode(
  sudo: true | string,
  targetPath: string,
): string | undefined {
  const absPath = path.resolve(targetPath); // ensure never starts with '-'
  // stdin: 'inherit' — see getSudoOwnerUid for rationale; same applies here.
  const gnu = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-L', '-c', '%a', '--', absPath],
    { stdio: ['inherit', 'pipe', 'ignore'] },
  );
  if (gnu.status === 0) return gnu.stdout.toString().trim() || undefined;
  // BSD stat (macOS) does not support '--'; path.resolve() ensures no leading '-'.
  // Use -L so that symlink ancestors are followed — without -L, stat returns the
  // symlink's own permissions (typically 0777) which would cause a false-positive
  // world-writable rejection.
  const bsd = spawnSync(
    'sudo',
    [...sudoUserArgs(sudo), 'stat', '-L', '-f', '%Lp', absPath],
    { stdio: ['inherit', 'pipe', 'ignore'] },
  );
  if (bsd.status === 0) return bsd.stdout.toString().trim() || undefined;
  return undefined;
}

// Verifies that a directory is safe to use as a mktemp staging location.
// Rejects directories that are group- or world-writable (mode & 0o022) WITHOUT
// the sticky bit — any member of the group or any local user could rename the
// just-created temp path to a symlink before the subsequent tee/cp opens it,
// redirecting the privileged write. Directories with the sticky bit set (e.g.
// /tmp on Linux) are safe: the sticky bit prevents users from renaming entries
// they do not own, neutralising the rename-to-symlink attack.
// When trustedUids is provided, also rejects directories whose owner UID is not
// in that set — the owner can always rename entries regardless of the sticky bit.
function checkDirSafe(
  sudo: true | string,
  absDir: string,
  trustedUids: Set<number> | undefined,
  label: string,
): void {
  let mode: number | undefined;
  let ownerUid: number | undefined;

  // Prefer unprivileged stat — ancestor directories like /usr/local/bin are
  // world-readable and do not require sudo. Avoiding sudo here prevents
  // repeated password prompts when sudo credential caching is unavailable
  // (e.g. timestamp_timeout=0 or when all stdio fds are non-TTY so macOS
  // sudo cannot locate the cached credential).
  //
  // Use lstatSync so that symlink ancestors are visible. When a path component
  // is a symlink inside a sticky world-writable directory (e.g. /tmp/link/),
  // the sticky bit only prevents *other* users from renaming the symlink — the
  // symlink's own owner can still rename it, redirecting privileged writes.
  // Checking the symlink's UID (not its target's UID) catches this case.
  try {
    const lst = fs.lstatSync(absDir);
    if (lst.isSymbolicLink()) {
      // For symlinks: the owner can rename the link regardless of the parent's
      // sticky bit. Use the symlink's UID for the ownership check.
      ownerUid = lst.uid;
      // Also capture the target directory's owner: mktemp/tee/mv operate
      // inside the resolved target, so its owner can rename root-created temp
      // entries regardless of the symlink's owner.
      let targetOwnerUid: number | undefined;
      // Follow the link to get the target directory's mode for the writable check.
      try {
        const s = fs.statSync(absDir);
        mode = s.mode & 0o7777;
        targetOwnerUid = s.uid;
      } catch (e2) {
        const code2 = (e2 as NodeJS.ErrnoException).code;
        if (code2 === 'ENOENT') {
          // Dangling symlink — target is gone, but ownerUid is already captured.
          // Do NOT return: fall through so the symlink owner is still validated
          // below. Without this check, an attacker can race between mkdir -p
          // (symlink pointing at a real dir) and mktemp/mv (dangling) to bypass
          // the trusted-UID guard entirely.
        } else if (code2 !== 'EACCES' && code2 !== 'EPERM') {
          throw e2;
        } else {
          // Symlink target is unreadable; fall back to sudo for mode and owner.
          // followSymlink=true so sudo stat follows the link to the target dir.
          const modeStr = getSudoFileMode(sudo, absDir);
          if (modeStr) mode = parseInt(modeStr, 8);
          targetOwnerUid = getSudoOwnerUid(sudo, absDir, true);
        }
      }
      // Validate the target directory's owner separately from the symlink owner.
      // Fail closed: if the target UID is unknown (dangling symlink or stat
      // failure), we cannot verify safety — reject rather than skip the check.
      if (trustedUids !== undefined) {
        if (targetOwnerUid === undefined) {
          throw new Error(
            `sudo write: ${label} directory ${absDir} symlink target owner UID could not be determined; ` +
              `cannot safely create a temp file here (TOCTOU risk).`,
          );
        }
        if (!trustedUids.has(targetOwnerUid)) {
          throw new Error(
            `sudo write: ${label} directory ${absDir} symlink target is owned by UID ${targetOwnerUid}, ` +
              `not a trusted identity; cannot safely create a temp file here (TOCTOU risk).`,
          );
        }
      }
    } else {
      mode = lst.mode & 0o7777;
      ownerUid = lst.uid;
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // directory does not exist yet; mkdir -p will create it
    // An unreadable (EACCES/EPERM) ancestor is safe: if the current user cannot
    // traverse it, no other unprivileged user can race inside it either. Only the
    // directory owner can perform a rename-to-symlink attack there, and the owner
    // is necessarily in the trusted set (root for sudo: true, or the named user
    // for sudo: "user"). Falling back to sudo stat here would produce an extra
    // password prompt for every unreadable ancestor before the worker prompt,
    // defeating the single-prompt guarantee on machines with timestamp_timeout=0.
    if (code === 'EACCES' || code === 'EPERM') return;
    throw e;
  }

  // A directory is unsafe when it is group- or world-writable AND does NOT have
  // the sticky bit set. With the sticky bit (e.g. /tmp on Linux, mode 01777),
  // only the file owner can rename or remove entries, so the rename-to-symlink
  // attack is neutralised.
  // Skip on Windows: NTFS ACLs do not map to Unix mode bits — fs.statSync
  // returns synthetic values that may falsely flag drives as world-writable.
  // The rename-to-symlink TOCTOU attack requires Unix filesystem semantics.
  if (process.platform !== 'win32') {
    const isWritable = mode !== undefined && !isNaN(mode) && !!(mode & 0o022);
    const hasSticky = mode !== undefined && !isNaN(mode) && !!(mode & 0o1000);
    if (isWritable && !hasSticky) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} is group- or world-writable; ` +
          `cannot safely create a temp file here (TOCTOU risk).`,
      );
    }
  }
  if (trustedUids !== undefined) {
    // Fail closed: if the owner UID is unknown (stat fallback also failed),
    // we cannot verify safety — reject rather than skip the check.
    if (ownerUid === undefined) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} owner UID could not be determined; ` +
          `cannot safely create a temp file here (TOCTOU risk).`,
      );
    }
    if (!trustedUids.has(ownerUid)) {
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
  checkedDirs?: Set<string>,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break; // reached filesystem root
  }
  for (const ancestor of ancestors) {
    if (checkedDirs?.has(ancestor)) continue;
    checkDirSafe(sudo, ancestor, trustedUids, `${label} ancestor`);
    checkedDirs?.add(ancestor);
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

  // Symlinks and mv-target files both use a stage-then-rename approach so
  // no destination path is touched until ALL staging AND backup work is done.
  const staged: Array<{ tmp: string; dest: string; effectiveMode?: number }> =
    [];
  // Staged temp symlinks — renamed into place in Phase 3 alongside mv targets.
  const stagedLinks: Array<{ tmp: string; dest: string }> = [];
  const backupTemps: string[] = [];
  try {
    // Phase 0 (symlink staging): create temp symlinks but do NOT rename yet.
    // Renames happen in Phase 3, after backups have captured the pre-write state.
    if (symlinkTargets.length > 0 && process.platform === 'win32') {
      throw new Error('symlink writes are not supported on Windows');
    }
    for (const t of symlinkTargets) {
      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      let tmpLink: string;
      for (;;) {
        tmpLink = path.join(
          dir,
          '.' +
            path.basename(t.targetPath) +
            '.' +
            crypto.randomBytes(8).toString('hex') +
            '.avanti-tmp',
        );
        try {
          fs.symlinkSync(t.symlinkTarget!, tmpLink);
          break;
        } catch (err) {
          // Retry on collision — same strategy as O_EXCL temp files.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      stagedLinks.push({ tmp: tmpLink, dest: t.targetPath });
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

    // Pre-validate writeInPlace targets before Phase 2: if any is a symlink,
    // Phase 4 will refuse to write through it. Fail early so no backup is
    // created for a write that will never proceed.
    for (const t of inPlaceTargets) {
      const entry = fs.lstatSync(t.targetPath, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) {
        throw new Error(
          `writeInPlace: ${t.targetPath} is a symlink; refusing to follow`,
        );
      }
    }

    // Phase 2: all staging succeeded — now create backups.
    // Phase 2a: copy each source file to a uniquely-named temp in the backup
    // dir. If any copy fails, no backup destination has been touched yet.
    const backupRenames: Array<{ tmp: string; dest: string }> = [];
    for (const t of targets) {
      if (!t.backupPath) continue;
      const existing = fs.lstatSync(t.targetPath, { throwIfNoEntry: false });
      if (!existing?.isFile() && !existing?.isSymbolicLink()) continue;
      if (existing.isSymbolicLink() && process.platform === 'win32') {
        // fs.symlinkSync requires elevated privileges on Windows; copyFileSync
        // would dereference the link and copy its target's contents, which is
        // misleading and can read files outside the working directory. Skip
        // before creating backupDir so no empty directory is left behind.
        console.warn(
          `Warning: cannot back up symlink ${t.targetPath} on Windows; backup skipped.`,
        );
        continue;
      }
      const backupDir = path.dirname(t.backupPath);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      // Copy via a uniquely-named temp file then rename so that:
      // (a) a symlink at backupPath is replaced, not followed, and
      // (b) a predictable temp path cannot be pre-created as a symlink.
      let backupTmp: string;
      if (existing.isSymbolicLink()) {
        // Preserve the symlink itself (not the file it points to) in the backup.
        // Resolve relative targets to absolute so the backup symlink resolves
        // correctly from backupDir, not just from the original link's directory.
        const rawLinkTarget = fs.readlinkSync(t.targetPath);
        const absLinkTarget = path.isAbsolute(rawLinkTarget)
          ? rawLinkTarget
          : path.resolve(path.dirname(t.targetPath), rawLinkTarget);
        // Retry on EEXIST — same strategy as the symlink staging loop (Phase 0).
        for (;;) {
          backupTmp = path.join(
            backupDir,
            '.' +
              path.basename(t.backupPath) +
              '.' +
              crypto.randomBytes(8).toString('hex') +
              '.avanti-backup-tmp',
          );
          try {
            fs.symlinkSync(absLinkTarget, backupTmp);
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          }
        }
      } else {
        for (;;) {
          backupTmp = path.join(
            backupDir,
            '.' +
              path.basename(t.backupPath) +
              '.' +
              crypto.randomBytes(8).toString('hex') +
              '.avanti-backup-tmp',
          );
          try {
            fs.copyFileSync(
              t.targetPath,
              backupTmp,
              fs.constants.COPYFILE_EXCL,
            );
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
              // copyFileSync may have created a partial file before failing
              // (e.g. ENOSPC, I/O error). Remove it so no orphan is left.
              fs.rmSync(backupTmp, { force: true });
              throw err;
            }
          }
        }
      }
      backupTemps.push(backupTmp);
      backupRenames.push({ tmp: backupTmp, dest: t.backupPath });
    }
    // Phase 2b: all copies succeeded — rename each backup temp into place.
    for (const { tmp, dest } of backupRenames) {
      fs.renameSync(tmp, dest);
    }

    // Phase 3: atomically rename all staged temps (files and symlinks) into place.
    // Only now are destination paths modified — all staging and backups succeeded.
    for (const s of stagedLinks) {
      fs.renameSync(s.tmp, s.dest);
    }
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
    for (const s of stagedLinks) {
      try {
        fs.rmSync(s.tmp, { force: true });
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
