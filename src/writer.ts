import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WriteOp,
} from './privileged-worker';

// os.tmpdir() may return a per-user private path on macOS (/var/folders/…)
// whose ancestor directories are not world-traversable, so a named sudo user
// cannot reach files placed there. /tmp is always world-executable on Unix
// (sticky 01777). Fall back to os.tmpdir() only on Windows.
// Override via AVANTI_WORLD_TMP for hardened systems where /tmp is mounted
// noexec (the worker exec fails with ENOEXEC in that case). The override path
// must be world-executable (all ancestor directories mode >=0711).
const WORLD_TMP =
  process.env.AVANTI_WORLD_TMP ??
  (process.platform === 'win32' ? os.tmpdir() : '/tmp');

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

// Resolves the Node.js binary to pass to sudo. For root sudo, process.execPath
// is always accessible. For named-user sudo, if process.execPath is under the
// calling user's home directory (nvm/fnm/mise installs), the target user cannot
// traverse $HOME and would get EACCES. In that case, search PATH for the first
// node binary outside $HOME; throws if none is found (a system-wide Node.js
// install is required for named-user sudo).
function resolveNodeExec(sudo: true | string): string {
  if (
    typeof sudo !== 'string' ||
    !process.execPath.startsWith(os.homedir() + path.sep)
  ) {
    return process.execPath;
  }
  // Known limitation: this search accepts the first node/nodejs binary outside
  // $HOME without checking its version. If the system Node (e.g. /usr/bin/node)
  // is older than the version that compiled the worker, the worker will fail
  // with a SyntaxError surfaced as "privileged worker failed (exit 1)". Ensure
  // a compatible Node.js is installed system-wide when using named-user sudo
  // with an nvm/fnm/mise-managed Node.
  // Allow an explicit override so users on systems with no system-wide Node
  // (e.g. developer machines that use nvm/fnm/mise exclusively) can still use
  // named-user sudo without installing a system-wide Node.js.
  if (process.env.AVANTI_NODE_EXEC) return process.env.AVANTI_NODE_EXEC;
  // Scan only known-safe system directories, not all of PATH. PATH may contain
  // world-writable directories under an attacker's control; returning a binary
  // from one of those would cause sudo -u <user> to execute attacker code.
  // sudo's secure_path would normally sanitise PATH, but spawnSync passes the
  // resolved binary as argv[0], bypassing secure_path entirely.
  const SAFE_DIRS =
    process.platform === 'darwin'
      ? ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin']
      : ['/usr/bin', '/usr/local/bin', '/bin'];
  for (const dir of SAFE_DIRS) {
    // Try both 'node' and 'nodejs': Debian/Ubuntu ship the binary as 'nodejs'.
    for (const name of ['node', 'nodejs']) {
      const candidate = path.join(dir, name);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
      } catch {
        // ignore EACCES, ENOENT, and any other stat error
      }
    }
  }
  throw new Error(
    `No Node.js binary found in ${SAFE_DIRS.join(', ')} for named-user sudo ('${sudo}'). ` +
      `Install Node.js system-wide (e.g. apt install nodejs) or set AVANTI_NODE_EXEC to the full path of a compatible Node.js binary.`,
  );
}

// Resolves the compiled privileged-worker.js path and throws if it does not
// exist (i.e. the user forgot to run `mise run build`).
function resolveWorkerPath(): string {
  const workerPath = __filename.endsWith('.ts')
    ? path.resolve(__dirname, '..', 'dist', 'privileged-worker.js')
    : path.join(__dirname, 'privileged-worker.js');
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `privileged worker not found at ${workerPath}` +
        (__filename.endsWith('.ts') ? '; run `mise run build` first' : ''),
    );
  }
  return workerPath;
}

// Deregisters dir from stagedWorkerDirs and removes it from disk.
// Called from normal cleanup paths and the process.on('exit') fallback.
function cleanupWorkerDir(dir: string): void {
  stagedWorkerDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Module-level registry of staged worker temp dirs. The 'exit' handler fires
// on normal exit and on explicit process.exit() calls. SIGTERM and SIGINT do
// NOT trigger 'exit' unless a signal handler calls process.exit() first;
// SIGKILL is uninterceptable and cannot be cleaned up.
// Guard against duplicate registration: Vitest can re-evaluate modules between
// test files, which would accumulate listeners and trigger MaxListenersExceededWarning.
const stagedWorkerDirs = new Set<string>();
// Module-level flag prevents duplicate handler registration when Vitest
// re-evaluates this module between test files without being affected by
// other modules that may have already registered their own 'exit' listeners.
// Use a process-level Symbol so the flag persists across Vitest module
// re-evaluations: a module-level boolean resets to false on each re-import,
// causing duplicate handler accumulation and MaxListenersExceededWarning.
const _HANDLERS_KEY = Symbol.for('avanti.writer.exitHandlersRegistered');
if (!(process as unknown as Record<symbol, unknown>)[_HANDLERS_KEY]) {
  (process as unknown as Record<symbol, unknown>)[_HANDLERS_KEY] = true;
  process.on('exit', () => {
    for (const d of [...stagedWorkerDirs]) {
      cleanupWorkerDir(d);
    }
  });
  process.once('SIGTERM', () => process.exit(1));
  process.once('SIGINT', () => process.exit(1));
}

// Copies the privileged-worker script to a world-readable temp directory so
// that `sudo -u <user>` can reach and exec it regardless of the calling user's
// home-directory permissions. Returns the staged path and temp directory;
// callers are responsible for cleaning up tmpDir when done.
function stageWorkerForSudo(workerPath: string): {
  stagedPath: string;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-worker-'));
  stagedWorkerDirs.add(tmpDir); // tracked for cleanup on abnormal exit
  // mkdtempSync mode is masked by the caller's umask (e.g. 077 → 0700), which
  // would prevent the named sudo user from traversing this directory. Chmod
  // explicitly to ensure the directory is always world-executable.
  fs.chmodSync(tmpDir, 0o755);
  const stagedPath = path.join(tmpDir, 'privileged-worker.js');
  fs.copyFileSync(workerPath, stagedPath);
  fs.chmodSync(stagedPath, 0o444);
  return { stagedPath, tmpDir };
}

// Shared setup for both runPrivilegedWorker (one-shot spawnSync) and
// SudoWorkerSession (persistent spawn): resolves the worker script path, the
// node executable to invoke via sudo, and stages it to a world-readable temp
// directory when using named-user sudo.  Callers are responsible for cleanup
// of tmpDir: runPrivilegedWorker uses a try/finally; SudoWorkerSession stores
// it in this.tmpDir and cleans up in close().
function prepareWorkerExec(sudo: true | string): {
  nodeExec: string;
  resolvedWorkerPath: string;
  tmpDir?: string;
} {
  const workerPath = resolveWorkerPath();
  const nodeExec = resolveNodeExec(sudo);
  if (typeof sudo === 'string') {
    const staged = stageWorkerForSudo(workerPath);
    return {
      nodeExec,
      resolvedWorkerPath: staged.stagedPath,
      tmpDir: staged.tmpDir,
    };
  }
  return { nodeExec, resolvedWorkerPath: workerPath };
}

function runPrivilegedWorker(
  sudo: true | string,
  ops: WriteOp[],
  continueOnError = false,
  trustedUids?: Set<number>,
): WorkerResult[] {
  if (process.platform === 'win32') {
    throw new Error('sudo is not supported on Windows');
  }
  const { nodeExec, resolvedWorkerPath, tmpDir } = prepareWorkerExec(sudo);
  const cleanup = tmpDir ? () => cleanupWorkerDir(tmpDir) : undefined;

  // Write the JSON request to a temp file and pass its path as --req-file so
  // stdin can be left as 'inherit'. When stdin is a pipe, macOS sudo calls
  // ttyname(STDIN_FILENO) which returns NULL and skips the credential cache,
  // forcing a password prompt even when the user just authenticated.
  const reqDir = tmpDir ?? os.tmpdir();
  const reqPath = path.join(
    reqDir,
    `avanti-req-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  fs.writeFileSync(
    reqPath,
    JSON.stringify({
      ops,
      trustedUids: [...(trustedUids ?? buildTrustedUids(sudo))],
      continueOnError,
    }),
    // Named-user tmpDir is world-executable (0755) so the worker binary is
    // reachable; the req file uses 0644 so the named user's process can read
    // it. Achieving tighter isolation (e.g. 0600 + chown to the named user)
    // would require a privilege-escalation step before the worker spawn and is
    // deferred. The path includes 16 random hex chars and exists only for the
    // duration of the spawnSync call, limiting practical exposure.
    { mode: typeof sudo === 'string' ? 0o644 : 0o600 },
  );

  let result;
  try {
    result = spawnSync(
      'sudo',
      [
        ...sudoUserArgs(sudo),
        nodeExec,
        resolvedWorkerPath,
        `--req-file=${reqPath}`,
      ],
      {
        stdio: ['inherit', 'pipe', 'inherit'],
        encoding: 'utf8',
        maxBuffer: 150 * 1024 * 1024,
      },
    );
  } finally {
    try {
      fs.unlinkSync(reqPath);
    } catch {
      // best-effort; tmpDir cleanup covers named-user case
    }
    cleanup?.();
  }

  if (result.error) {
    if (
      (result.error as NodeJS.ErrnoException).code ===
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw new Error(
        'privileged worker stdout exceeded the 150 MiB maxBuffer — batch is too large; use SudoWorkerSession for large read ops',
        { cause: result.error },
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    // If continueOnError is set, the worker may have written partial results to
    // stdout before exiting (e.g. crashed after some ops completed). Return
    // them so callers can record which ops succeeded rather than losing all
    // partial state.
    if (continueOnError && result.stdout) {
      try {
        const partial = JSON.parse(result.stdout) as {
          results: WorkerResult[];
        };
        if (Array.isArray(partial.results) && partial.results.length > 0) {
          return partial.results;
        }
      } catch {
        // fall through to throw
      }
    }
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
    if (results.length !== ops.length) {
      // Surface the actual failure message if an op failed early; a count
      // mismatch alone tells the caller nothing useful.
      const firstFailed = results.find((r) => !r.ok);
      throw new Error(
        firstFailed?.error ??
          `privileged worker returned ${results.length} results, expected ${ops.length}`,
      );
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
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
// chmodTargets are batched into the same per-identity invocation as the writes
// so that a pull with both content changes and mode-only changes for the same
// sudo identity still produces exactly one prompt.
// Returns the count of chmod ops that were actually applied (ENOENT/ELOOP skips
// are not counted).
export async function sudoAtomicWrite(
  targets: SudoWriteTarget[],
  chmodTargets: SudoChmodTarget[] = [],
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<number> {
  if (targets.length === 0 && chmodTargets.length === 0) return 0;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const mask = process.umask();
  const defaultMode = (0o666 & ~mask).toString(8).padStart(4, '0');

  // Hoist UID lookup: buildTrustedUids spawns `id -u <user>` — dedupe per
  // identity and reuse session.trustedUids when a session already holds them.
  const trustedUidsBySudo = new Map<true | string, Set<number>>();
  const allSudoIds = new Set<true | string>([
    ...targets.map((t) => t.sudo),
    ...chmodTargets.map((t) => t.sudo),
  ]);
  for (const sudoId of allSudoIds) {
    trustedUidsBySudo.set(
      sudoId,
      sessions?.get(sudoId)?.trustedUids ?? buildTrustedUids(sudoId),
    );
  }

  // Validate ancestor safety for all targets before any privileged work.
  // checkAncestorsSafe prefers lstatSync (0 sudo calls) for world-readable
  // paths like /usr/local/bin; sudo stat is only used for unreadable ancestors.
  const checkedDirsBySudo = new Map<true | string, Set<string>>();
  for (const t of targets) {
    const trustedUids = trustedUidsBySudo.get(t.sudo)!;
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

  // Validate ancestor safety for chmod targets. These share the checkedDirsBySudo
  // set so dirs already validated for write targets are not rechecked.
  for (const t of chmodTargets) {
    const trustedUids = trustedUidsBySudo.get(t.sudo)!;
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
  }

  // Append chmod ops after write ops so they share the same per-identity worker.
  // Track the index range for chmod ops so we can correlate results for counting.
  const chmodStartIndex = new Map<true | string, number>();
  for (const t of chmodTargets) {
    const op: WriteOp = {
      type: 'chmod',
      targetPath: t.targetPath,
      mode: t.mode,
    };
    targetOps.push({ sudo: t.sudo, op });
  }

  // Group ops by sudo identity; one worker invocation per group.
  // Track the index of the first chmod op per identity while building the
  // groups — avoids a redundant findIndex scan afterward.
  const groups = new Map<true | string, WriteOp[]>();
  for (const { sudo, op } of targetOps) {
    const existing = groups.get(sudo);
    if (existing) {
      if (op.type === 'chmod' && !chmodStartIndex.has(sudo)) {
        chmodStartIndex.set(sudo, existing.length);
      }
      existing.push(op);
    } else {
      if (op.type === 'chmod') chmodStartIndex.set(sudo, 0);
      groups.set(sudo, [op]);
    }
  }

  let chmodApplied = 0;
  for (const [sudo, ops] of groups) {
    let results: Array<{ ok: boolean; error?: string; skipped?: boolean }>;
    const session = sessions?.get(sudo);
    if (session) {
      results = await session.exec(ops);
      // Check for failures
      for (const r of results) {
        if (!r.ok) throw new Error(r.error ?? 'privileged worker op failed');
      }
    } else {
      results = runPrivilegedWorker(
        sudo,
        ops,
        false,
        trustedUidsBySudo.get(sudo),
      );
    }
    // Count chmod results that weren't silently skipped (ENOENT/ELOOP).
    const start = chmodStartIndex.get(sudo) ?? ops.length;
    for (let i = start; i < results.length; i++) {
      if (results[i].ok && !results[i].skipped) chmodApplied++;
    }
  }
  return chmodApplied;
}

// Appends value to the slice at groups[key], creating it if absent.
// Deduplicates the group-by-sudo-identity pattern used across batch functions.
function addToGroup<V>(
  groups: Map<true | string, V[]>,
  key: true | string,
  value: V,
): void {
  const existing = groups.get(key);
  if (existing) existing.push(value);
  else groups.set(key, [value]);
}

// Batches privileged deletions into one worker invocation per sudo identity.
// Returns the set of paths that were successfully deleted.
// When bestEffort is false (default), worker-level failures throw; individual
// per-path failures also throw. When bestEffort is true, both are warned and
// the partial success set is returned — used by pull's stale-file cleanup.
export async function sudoAtomicDelete(
  deletions: Array<[string, true | string]>,
  bestEffort = false,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<Set<string>> {
  const succeeded = new Set<string>();
  if (deletions.length === 0) return succeeded;
  // Track per-sudo ordered path lists to correlate results with paths.
  const groups = new Map<true | string, string[]>();
  for (const [p, sudo] of deletions) {
    addToGroup(groups, sudo, p);
  }
  for (const [sudo, paths] of groups) {
    const ops: WriteOp[] = paths.map((p) => ({
      type: 'delete',
      targetPath: p,
    }));
    try {
      const session = sessions?.get(sudo);
      const results: WorkerResult[] = session
        ? await session.exec(ops, true)
        : runPrivilegedWorker(sudo, ops, true);
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

// Batches multiple privileged reads into a single worker invocation per
// sudo identity, so pre-write idempotency checks and v0 history captures
// for unreadable files all share one sudo prompt with the subsequent writes.
// Returns a Map keyed by the original filePath values.
export async function sudoAtomicRead(
  reads: Array<{
    filePath: string;
    sudo: true | string;
    type?: 'stat-read' | 'read' | 'readlink';
  }>,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<Map<string, { contentB64: string; isSymlink?: boolean } | null>> {
  const resultMap = new Map<
    string,
    { contentB64: string; isSymlink?: boolean } | null
  >();
  if (reads.length === 0) return resultMap;

  // Group by sudo identity.
  const groups = new Map<
    true | string,
    Array<{
      filePath: string;
      type: 'stat-read' | 'read' | 'readlink';
      idx: number;
    }>
  >();
  reads.forEach((r, idx) => {
    addToGroup(groups, r.sudo, {
      filePath: r.filePath,
      type: r.type ?? 'read',
      idx,
    });
  });

  for (const [sudo, items] of groups) {
    const ops: WriteOp[] = items.map((item) => ({
      type: item.type,
      targetPath: path.resolve(item.filePath),
    }));
    // Worker-level failure (e.g. build missing, JSON parse error, OOM) must
    // propagate: silently falling back to null would skip v0 history capture
    // for every file in the batch, permanently breaking revert/reset without
    // any user-visible error.
    const session = sessions?.get(sudo);
    const results: Array<{
      ok: boolean;
      contentB64?: string;
      isSymlink?: boolean;
      error?: string;
      code?: string;
    }> = session
      ? await session.exec(ops, true)
      : runPrivilegedWorker(sudo, ops, true);
    items.forEach((item, i) => {
      const r = results[i];
      if (r?.ok && r.contentB64 != null) {
        resultMap.set(item.filePath, {
          contentB64: r.contentB64,
          isSymlink: r.isSymlink,
        });
      } else if (
        r &&
        !r.ok &&
        r.code !== 'ENOENT' &&
        r.code !== 'EACCES' &&
        r.code !== 'EPERM' &&
        r.code !== 'EISDIR' &&
        r.code !== 'ENOTREGFILE'
      ) {
        // Non-absence, non-permission, non-type errors (e.g. file too large)
        // must not be silently treated as missing — the write would proceed
        // without capturing v0 content, risking data loss.
        // EACCES/EPERM: worker cannot read the file (e.g. named-user cannot
        // traverse a parent directory) — treat as null so the pull proceeds.
        // EISDIR/ENOTREGFILE: path exists but is not a regular file or symlink
        // (e.g. a directory or special file) — no v0 content to capture, so
        // treat as null rather than aborting the pull.
        throw new Error(
          `privileged read of ${item.filePath} failed: ${r.error}`,
        );
      } else {
        resultMap.set(item.filePath, null);
      }
    });
  }

  return resultMap;
}

// Batches stat-read ops for paths whose parent directory is not searchable
// (lstatFailed). Each stat-read result tells us: does the path exist, is it a
// symlink, is it a directory, and what is its current mode (regular files only)?
// Uses the session when available so no extra sudo process is spawned. Replaces
// the per-file sudoFileExists / sudoIsSymlink / sudoIsDirectory helpers (each
// of which spawns a separate sudo process).
export async function sudoStatBatch(
  targets: Array<{ filePath: string; sudo: true | string }>,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<
  Map<
    string,
    { exists: boolean; isSymlink: boolean; isDirectory: boolean; mode?: string }
  >
> {
  const result = new Map<
    string,
    { exists: boolean; isSymlink: boolean; isDirectory: boolean; mode?: string }
  >();
  if (targets.length === 0) return result;

  // Group by sudo identity.
  const groups = new Map<true | string, Array<{ filePath: string }>>();
  targets.forEach((t) => {
    addToGroup(groups, t.sudo, { filePath: t.filePath });
  });

  for (const [sudo, items] of groups) {
    const ops: WriteOp[] = items.map((item) => ({
      type: 'stat-read' as const,
      targetPath: item.filePath,
    }));
    const session = sessions?.get(sudo);
    let results: WorkerResult[];
    if (session) {
      results = await session.exec(ops, true);
    } else {
      results = runPrivilegedWorker(sudo, ops, true);
    }
    items.forEach((item, j) => {
      const r = results[j];
      const isSymlink = !!(r?.ok && r.isSymlink === true);
      const isDirectory = !!(r && !r.ok && r.code === 'EISDIR');
      const isSpecialFile = !!(r && !r.ok && r.code === 'ENOTREGFILE');
      const exists = !!(r?.ok || isDirectory || isSpecialFile);
      result.set(item.filePath, {
        exists,
        isSymlink,
        isDirectory,
        mode: r?.mode,
      });
    });
  }
  return result;
}

// Performs a privileged rename of src to dst. On Linux, GNU mv -T is used so
// mv refuses to move src *inside* dst when dst is a directory — preventing a
// TOCTOU race where dst is swapped for a directory after the precheck. BSD mv
// (macOS) does not support -T, so the flag is omitted on non-Linux platforms.

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

export class SudoWorkerSession {
  private proc: ReturnType<typeof spawn>;
  private dataIn: NodeJS.WritableStream;
  private tmpDir?: string;
  private rl: readline.Interface;
  private pending: {
    resolve: (results: WorkerResult[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private closed = false;
  readonly trustedUids: Set<number>;
  readonly sudo: true | string;

  constructor(sudo: true | string) {
    if (process.platform === 'win32')
      throw new Error('sudo is not supported on Windows');
    this.sudo = sudo;
    this.trustedUids = buildTrustedUids(sudo);

    const { nodeExec, resolvedWorkerPath, tmpDir } = prepareWorkerExec(sudo);
    if (tmpDir) this.tmpDir = tmpDir;

    // Open /dev/tty so that sudo can look up cached credentials via
    // ttyname(STDIN_FILENO). When stdin is a pipe (stdio: ['pipe',…]), macOS
    // sudo's ttyname() returns NULL and ignores the credential cache, forcing
    // a password re-prompt every time. Fall back to 'inherit' (the caller's
    // own stdin) when no controlling TTY is available (CI, containers, etc.).
    let ttyFd: number | undefined;
    try {
      ttyFd = fs.openSync('/dev/tty', 'r+');
    } catch {
      /* no controlling TTY */
    }

    this.proc = spawn(
      'sudo',
      [...sudoUserArgs(sudo), nodeExec, resolvedWorkerPath, '--data-fd=3'],
      {
        // stdio[0]: /dev/tty (or inherited stdin) so sudo's ttyname() succeeds
        // stdio[1]: pipe for JSON response lines from the worker
        // stdio[2]: inherited stderr for sudo prompts and error messages
        // stdio[3]: pipe for JSON request lines to the worker (the data channel)
        stdio: [ttyFd ?? 'inherit', 'pipe', 'inherit', 'pipe'],
      },
    );
    if (ttyFd !== undefined) fs.closeSync(ttyFd);

    // fd 3 is the write end of the data pipe (stdio[3]).
    this.dataIn = (
      this.proc as unknown as { stdio: Array<NodeJS.WritableStream | null> }
    ).stdio[3]!;

    // readline handles line buffering internally, avoiding the O(n²) cost of
    // Buffer.concat on every data event for large responses.
    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });
    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const response = JSON.parse(trimmed) as WorkerResponse;
        const p = this.pending;
        this.pending = null;
        p?.resolve(response.results);
      } catch (e) {
        this.closed = true;
        const p = this.pending;
        this.pending = null;
        p?.reject(
          new Error(`failed to parse worker response: ${(e as Error).message}`),
        );
      }
    });

    this.proc.on('error', (err) => {
      this.closed = true;
      const p = this.pending;
      this.pending = null;
      p?.reject(err);
    });

    // EPIPE is emitted on the data channel when the child exits while we are
    // writing to it. Without a listener Node.js would throw an unhandled
    // exception and crash the CLI process. Reject the in-flight request instead.
    this.dataIn.on('error', (err) => {
      const p = this.pending;
      this.pending = null;
      this.closed = true;
      this.rl.close();
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // already dead
      }
      p?.reject(err as Error);
    });

    this.proc.on('close', (code, signal) => {
      this.closed = true;
      const p = this.pending;
      this.pending = null;
      if (p) {
        // Reject whether exit was clean (0) or not — a clean exit with an
        // in-flight request means the worker died without sending a response,
        // and leaving the promise pending would cause a 30s timeout hang.
        p.reject(
          new Error(
            code === 0
              ? 'privileged worker exited unexpectedly with no response'
              : code !== null
                ? `privileged worker failed (exit ${code})`
                : `privileged worker killed (signal ${signal ?? 'unknown'})`,
          ),
        );
      }
    });
  }

  async exec(
    ops: WriteOp[],
    continueOnError = false,
    timeoutMs = 30_000,
  ): Promise<WorkerResult[]> {
    if (this.closed) throw new Error('SudoWorkerSession: session is closed');
    if (this.pending)
      throw new Error(
        'SudoWorkerSession: concurrent exec() calls are not supported',
      );
    return new Promise<WorkerResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        // Use setImmediate so the poll-phase (I/O) runs first: if a readline
        // 'line' event was already buffered when the timer fired, it resolves
        // this.pending before this callback executes, and the guard above exits
        // early — preventing a spurious timeout rejection.
        setImmediate(() => {
          if (!this.pending) return;
          this.pending = null;
          this.proc.kill('SIGTERM');
          this.close(); // sets this.closed=true and cleans up tmpDir
          reject(new Error('SudoWorkerSession: exec() timed out'));
        });
      }, timeoutMs);
      this.pending = {
        resolve: (r) => {
          clearTimeout(timer);
          if (r.length !== ops.length) {
            const firstFailed = r.find((x) => !x.ok);
            const detail =
              firstFailed?.error ??
              `privileged worker returned ${r.length} results, expected ${ops.length}`;
            this.close();
            reject(new Error(detail));
          } else {
            resolve(r);
          }
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const request: WorkerRequest = {
        ops,
        trustedUids: [...this.trustedUids],
        continueOnError,
      };
      this.dataIn.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = null;
          this.closed = true;
          reject(err);
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    const p = this.pending;
    this.pending = null;
    this.closed = true;
    p?.reject(new Error('SudoWorkerSession: session closed'));
    this.rl.close();
    this.dataIn.end();
    const t = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
    t.unref();
    this.proc.once('close', () => clearTimeout(t));
    if (this.tmpDir) {
      cleanupWorkerDir(this.tmpDir);
    }
  }
}

// Closes every session in the map. Call this in error paths and finally blocks
// so callers do not need to repeat the loop in every early-exit path.
export function closeAllSessions(
  sessions: Map<true | string, SudoWorkerSession>,
): void {
  for (const session of sessions.values()) session.close();
}

// Opens one SudoWorkerSession per distinct sudo identity and returns the map.
// On failure, closes any sessions already opened and rethrows so the caller
// can handle the error (typically process.exit(2) with a console.error).
// On Windows, returns an empty map (sudo is not supported).
export function openPrivilegedSessions(
  sudoIds: Iterable<true | string>,
): Map<true | string, SudoWorkerSession> {
  const sessions = new Map<true | string, SudoWorkerSession>();
  if (process.platform === 'win32') return sessions;
  try {
    for (const id of sudoIds) sessions.set(id, new SudoWorkerSession(id));
  } catch (err) {
    closeAllSessions(sessions);
    throw err;
  }
  return sessions;
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
  // stdin: 'inherit' passes the parent's fd 0 so sudo can locate cached
  // credentials by TTY name; 'ignore' (non-TTY /dev/null) would break that
  // lookup and cause a re-prompt in interactive sessions.
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
        } else if (code2 === 'EACCES' || code2 === 'EPERM') {
          // Symlink target is unreadable without root. Skip the owner/mode check
          // here and rely on checkAncestorsSafeAsRoot inside the worker, which
          // runs as root and has no EACCES constraint. A pre-worker check via
          // getSudoFileMode/getSudoOwnerUid would fire a separate password prompt
          // on machines with timestamp_timeout=0, breaking the single-prompt
          // guarantee that is the core of this PR.
          return;
        } else {
          throw e2;
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
    // An unreadable (EACCES/EPERM) ancestor: we cannot lstat it without an
    // extra sudo call, which would add a password prompt for every unreadable
    // ancestor before the worker prompt and break the single-prompt guarantee
    // on machines with timestamp_timeout=0. We skip the owner check here and
    // rely on the privileged worker's checkAncestorsSafeAsRoot — which runs as
    // root and has no EACCES early-return — to re-validate all ancestors at
    // write time before touching any file. Note: a caller-side skip followed
    // by a world-writable restore in the window before the worker check is a
    // residual race; the worker's check catches it if the directory is still
    // world-writable when the worker runs.
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
