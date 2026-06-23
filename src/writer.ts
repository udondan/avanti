import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { parseMode } from './privileged-worker';
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
const WORLD_TMP_OVERRIDE = process.env.AVANTI_WORLD_TMP;
if (WORLD_TMP_OVERRIDE && process.platform !== 'win32') {
  // Validate the override: it must not be world-writable without the sticky bit
  // (1000). Without sticky, any local user can rename/unlink files in the
  // directory, enabling a race to replace the staged worker or IPC socket dir.
  try {
    const st = fs.lstatSync(WORLD_TMP_OVERRIDE);
    const isWorldWritable = (st.mode & 0o002) !== 0;
    const hasSticky = (st.mode & 0o1000) !== 0;
    if (isWorldWritable && !hasSticky) {
      throw new Error(
        `AVANTI_WORLD_TMP=${WORLD_TMP_OVERRIDE} is world-writable without the sticky bit — ` +
          'any local user could race the temp directory. Set the sticky bit or use a private directory.',
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`AVANTI_WORLD_TMP=${WORLD_TMP_OVERRIDE} does not exist`, {
        cause: e,
      });
    }
    throw e;
  }
}
const WORLD_TMP =
  WORLD_TMP_OVERRIDE ?? (process.platform === 'win32' ? os.tmpdir() : '/tmp');

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
// Cache the resolved node binary path per sudo identity. The path is stable for
// the lifetime of the process — no need to re-scan SAFE_DIRS and re-spawn
// `node --version` on every new SudoWorkerSession. Keyed by identity so that a
// root session (which may cache a root-owned binary inaccessible to other users)
// does not pollute the cache for a subsequent named-user session.
const resolvedNodeExecCache = new Map<string, string>();

function resolveNodeExec(sudo: true | string): string {
  // SECURITY: AVANTI_NODE_EXEC bypasses ALL root-ownership and version checks
  // on the Node binary passed to `sudo`. Any process that can set this env var
  // for avanti can redirect sudo to execute an arbitrary binary as root.
  // Only set this in controlled environments (tests, NixOS/Guix with a system-
  // managed node) where the supplied path is known trustworthy. Never set it
  // from untrusted input. Tests must clear it in afterEach.
  // Note: shell commands run by the `exec:` source type are subprocesses of
  // avanti; environment variables set inside them do NOT propagate back to the
  // parent avanti process. A remote config using `exec:` cannot inject this
  // variable into avanti's environment.
  // Not cached: the env var can legitimately change between calls in tests.
  if (process.env.AVANTI_NODE_EXEC) {
    return process.env.AVANTI_NODE_EXEC;
  }
  const cacheKey = sudo === true ? '__root__' : sudo;
  const cached = resolvedNodeExecCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // Minimum Node.js major version that can run the compiled worker.
  // The worker is compiled to ES2022 (tsconfig.build.json target), which
  // Node.js 18+ supports fully. Using the current process's major version
  // as the threshold is wrong: when the caller runs under nvm/mise (e.g.
  // v24), a system node v18 is perfectly capable of running the ES2022
  // compiled output and would be rejected without cause.
  const WORKER_MIN_NODE_MAJOR = 18;
  // Require the binary to be root-owned before trusting it when running via
  // sudo — whether elevating to root or to a named user. If process.execPath
  // is user-owned (e.g. a Homebrew or nvm/fnm/mise install), the calling user
  // could replace it with malicious code that runs with elevated privileges.
  // Fall through to the SAFE_DIRS scan if the ownership check fails or if
  // process.execPath is inside $HOME.
  // Resolve symlinks before checking ownership to eliminate the TOCTOU window
  // where a symlink in a user-writable directory (e.g. /usr/local/bin on macOS)
  // could be swapped between our stat check and sudo's exec. realpathSync also
  // ensures we stat and return the real inode, not an intermediate link.
  try {
    const realPath = fs.realpathSync(process.execPath);
    const st = fs.statSync(realPath);
    if (
      st.isFile() &&
      (st.mode & 0o111) !== 0 &&
      st.uid === 0 &&
      !realPath.startsWith(os.homedir() + path.sep)
    ) {
      // Apply the same version floor as the SAFE_DIRS scan so that a stale
      // root-owned binary (e.g. v16) does not silently produce an opaque
      // SyntaxError inside the worker.
      // Short timeout: `node --version` is instantaneous; 2s is generous enough
      // for any working install while avoiding a 5s stall per candidate on slow
      // systems (e.g. cold NFS mounts or heavily loaded CI boxes).
      const vr = spawnSync(realPath, ['--version'], {
        encoding: 'utf8',
        timeout: 2000,
      });
      const m = vr.stdout?.trim().match(/^v(\d+)\./);
      if (m && parseInt(m[1], 10) >= WORKER_MIN_NODE_MAJOR) {
        resolvedNodeExecCache.set(cacheKey, realPath);
        return realPath;
      }
      // Version too old — fall through to SAFE_DIRS scan.
    }
  } catch {
    // ignore and fall through to SAFE_DIRS search
  }
  // Scan only known-safe system directories, not all of PATH. PATH may contain
  // world-writable directories under an attacker's control; returning a binary
  // from one of those would cause sudo to execute attacker code.
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
        const realPath = fs.realpathSync(candidate);
        const st = fs.statSync(realPath);
        // Require root ownership: on Apple Silicon, /opt/homebrew is user-owned
        // so a Homebrew-installed node binary is writable by the calling user.
        // Accepting such a binary would allow the calling user to replace it with
        // malicious code that executes as the sudo target.
        if (!st.isFile() || (st.mode & 0o111) === 0 || st.uid !== 0) continue;
        // Version check: reject binaries older than the compiled worker requires.
        // This turns an opaque "privileged worker failed (exit 1)" SyntaxError
        // into an actionable "no compatible binary found" message.
        // Short timeout: `node --version` is instantaneous; 2s per candidate.
        const versionResult = spawnSync(realPath, ['--version'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        const match = versionResult.stdout?.trim().match(/^v(\d+)\./);
        if (!match) continue;
        const candidateMajor = parseInt(match[1], 10);
        if (candidateMajor < WORKER_MIN_NODE_MAJOR) {
          continue;
        }
        resolvedNodeExecCache.set(cacheKey, realPath);
        return realPath;
      } catch {
        // ignore EACCES, ENOENT, and any other stat/spawn error
      }
    }
  }
  const sudoDesc =
    typeof sudo === 'string' ? `named-user sudo ('${sudo}')` : 'root sudo';
  // SAFE_DIRS covers Debian/Ubuntu, macOS, and Alpine. Non-standard distros
  // (NixOS: /nix/store/…/bin/node, Guix, custom builds) may not have any
  // root-owned binary in these paths. Set AVANTI_NODE_EXEC to the absolute
  // path of any root-owned, compatible Node.js binary to bypass this scan.
  throw new Error(
    `No root-owned Node.js binary (v${WORKER_MIN_NODE_MAJOR}+) found in ${SAFE_DIRS.join(', ')} for ${sudoDesc}. ` +
      `On NixOS or other non-standard distros, set the AVANTI_NODE_EXEC environment variable to the absolute ` +
      `path of a root-owned, compatible Node.js binary (e.g. AVANTI_NODE_EXEC=$(readlink -f $(which node))). ` +
      `On standard distros, install Node.js system-wide (e.g. apt install nodejs, brew install node).`,
  );
}

// Resolves the compiled privileged-worker.js path and throws if it does not
// exist (i.e. the user forgot to run `mise run build`). Cached: __dirname and
// __filename are constant for the process lifetime so the path never changes.
let _cachedWorkerPath: string | undefined;
function resolveWorkerPath(): string {
  if (_cachedWorkerPath !== undefined) return _cachedWorkerPath;
  const workerPath = __filename.endsWith('.ts')
    ? path.resolve(__dirname, '..', 'dist', 'privileged-worker.js')
    : path.join(__dirname, 'privileged-worker.js');
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `privileged worker not found at ${workerPath}` +
        (__filename.endsWith('.ts') ? '; run `mise run build` first' : ''),
    );
  }
  _cachedWorkerPath = workerPath;
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

// Use process-level Symbols to store the Sets so that all evaluations of this
// module (e.g. Vitest re-importing between test files) share the exact same
// Set instances. Module-level `const` Sets are re-created on each re-import,
// but the exit/signal handlers (registered only once via _HANDLERS_KEY) capture
// the FIRST evaluation's Sets via closure — new entries added after re-import
// would be invisible to the handlers and leaked on process exit.
const _DIRS_KEY = Symbol.for('avanti.writer.stagedWorkerDirs');
const _SESSIONS_KEY = Symbol.for('avanti.writer.activeSudoSessions');
const _proc = process as unknown as Record<symbol, unknown>;

// Registry of staged worker temp dirs. The 'exit' handler fires on normal exit
// and on explicit process.exit() calls. SIGTERM and SIGINT do NOT trigger
// 'exit' unless a signal handler calls process.exit() first; SIGKILL is
// uninterceptable and cannot be cleaned up.
if (!_proc[_DIRS_KEY]) _proc[_DIRS_KEY] = new Set<string>();
const stagedWorkerDirs = _proc[_DIRS_KEY] as Set<string>;

// Tracks all live SudoWorkerSession instances so signal handlers can close them
// before calling process.exit(1). This prevents write batches from completing
// in the worker after the parent exits and leaving history in an inconsistent state.
if (!_proc[_SESSIONS_KEY]) _proc[_SESSIONS_KEY] = new Set<SudoWorkerSession>();
const activeSudoSessions = _proc[_SESSIONS_KEY] as Set<SudoWorkerSession>;

// Module-level flag prevents duplicate handler registration when Vitest
// re-evaluates this module between test files.
const _HANDLERS_KEY = Symbol.for('avanti.writer.exitHandlersRegistered');
if (!_proc[_HANDLERS_KEY]) {
  _proc[_HANDLERS_KEY] = true;
  process.on('exit', () => {
    for (const d of [...stagedWorkerDirs]) {
      cleanupWorkerDir(d);
    }
  });
  // process.on() suppresses Node's default signal termination, so the handler
  // must always call process.exit() — otherwise the process silently absorbs
  // SIGINT/SIGTERM when no sessions are active and hangs instead of exiting.
  const teardown = (signal: string): void => {
    const hadSessions = activeSudoSessions.size > 0;
    for (const s of [...activeSudoSessions]) {
      try {
        s.close();
      } catch {
        // best-effort
      }
    }
    // Always use the POSIX signal exit code (128+signum) so shells can
    // distinguish user-abort from a generic error regardless of whether
    // sessions were active. Deferred one tick when sessions were open so
    // Promise rejections from s.close() propagate before the process ends.
    const exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
    if (hadSessions) {
      setImmediate(() => process.exit(exitCode));
    } else {
      process.exit(exitCode);
    }
  };
  process.on('SIGTERM', teardown);
  process.on('SIGINT', teardown);
}

// Cache of staged worker binaries keyed on the source workerPath. Multiple
// named-user sessions for different identities share one copy so the binary
// is not copied redundantly within a process lifetime. The tmpDir stays alive
// until process exit (tracked in stagedWorkerDirs); sessions do NOT clean it
// up on close() — they each own their own per-session ipcDir instead.
const _workerStagingCache = new Map<string, string>();

// Copies the privileged-worker script to a world-readable temp directory so
// that `sudo -u <user>` can reach and exec it regardless of the calling user's
// home-directory permissions. Returns the staged path; the tmpDir is owned by
// the module (tracked in stagedWorkerDirs) and lives until process exit.
function stageWorkerForSudo(workerPath: string): string {
  const cached = _workerStagingCache.get(workerPath);
  if (cached !== undefined) return cached;
  // mkdtemp(2) is POSIX-specified to create with mode S_IRWXU (0700) regardless
  // of the caller's umask, so no umask manipulation is required here.
  const tmpDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-worker-'));
  try {
    // Chmod to 0o711: the named sudo user needs to traverse and exec the script
    // but must not be able to list the directory contents.
    fs.chmodSync(tmpDir, 0o711);
    const stagedPath = path.join(tmpDir, 'privileged-worker.js');
    fs.copyFileSync(workerPath, stagedPath);
    fs.chmodSync(stagedPath, 0o444);
    stagedWorkerDirs.add(tmpDir); // tracked for process-exit cleanup
    _workerStagingCache.set(workerPath, stagedPath);
    return stagedPath;
  } catch (e) {
    // Clean up immediately on staging failure; do not rely solely on process-
    // exit cleanup since a retry loop would accumulate orphaned directories.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

// Shared setup for both runPrivilegedWorker (one-shot spawnSync) and
// SudoWorkerSession (persistent spawn): resolves the worker script path and
// the node executable to invoke via sudo, staging the binary to a world-
// readable temp dir for named-user sudo. The staged dir is owned by the
// module (process-exit cleanup), NOT the caller.
function prepareWorkerExec(sudo: true | string): {
  nodeExec: string;
  resolvedWorkerPath: string;
} {
  const workerPath = resolveWorkerPath();
  const nodeExec = resolveNodeExec(sudo);
  if (typeof sudo === 'string') {
    return {
      nodeExec,
      resolvedWorkerPath: stageWorkerForSudo(workerPath),
    };
  }
  return { nodeExec, resolvedWorkerPath: workerPath };
}

function runPrivilegedWorker(
  sudo: true | string,
  ops: WriteOp[],
  continueOnError = false,
): WorkerResult[] {
  if (process.platform === 'win32') {
    throw new Error('sudo is not supported on Windows');
  }
  const { nodeExec, resolvedWorkerPath } = prepareWorkerExec(sudo);

  // The worker does not accept trustedUids over the wire — it recomputes the
  // trusted set from SUDO_UID (set by sudo) and its own UID. Hardened sudoers
  // configurations that strip SUDO_UID (env_reset without env_keep += SUDO_UID)
  // will limit the worker's trusted set to {0, workerUid}, which may cause
  // ancestor-safety checks to reject user-owned backup/config paths.
  const reqPayload = JSON.stringify({
    ops,
    continueOnError,
  });

  // For root sudo, stdin must be 'inherit' so macOS sudo's ttyname() succeeds
  // and the credential cache is consulted (piped stdin causes ttyname to return
  // NULL, bypassing the cache and forcing a re-prompt). Write the request to a
  // temp file (mode 0o600, readable only by root) so stdin stays free.
  //
  // For named-user sudo, pass the request via stdin pipe instead. This avoids
  // writing file contents to a world-readable temp file in WORLD_TMP — the
  // named sudo user reads the JSON directly from the pipe and the data never
  // touches disk. The macOS credential-cache regression (ttyname returns NULL)
  // is acceptable: named-user sudo is rarer than root sudo, and the security
  // gain outweighs the UX cost.
  const isNamedUser = typeof sudo === 'string';
  // For named-user sudo (stdin pipe path), generate a per-invocation nonce and
  // prepend it as the first line of stdin. The worker verifies it against
  // AVANTI_WORKER_NONCE before processing any ops. This authenticates the pipe
  // input so a rogue process that gains access to the pipe cannot issue ops.
  const stdinNonce = isNamedUser
    ? crypto.randomBytes(32).toString('hex')
    : undefined;
  // For root sudo, create a dedicated 0700 temp dir for the req file so
  // that concurrent processes running as the same user cannot race to replace
  // the file between writeFileSync and spawnSync. os.tmpdir() on macOS returns
  // a per-user path without sticky-bit protection; WORLD_TMP (/tmp on POSIX)
  // has the sticky bit and isolates the req file in an owner-only directory.
  let reqTmpDir: string | undefined;
  let reqPath: string | undefined;
  let result;
  try {
    if (!isNamedUser) {
      reqTmpDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-req-'));
      reqPath = path.join(
        reqTmpDir,
        `avanti-req-${crypto.randomBytes(8).toString('hex')}.json`,
      );
      const reqFd = fs.openSync(reqPath, 'wx', 0o600);
      try {
        fs.writeFileSync(reqFd, reqPayload);
      } finally {
        fs.closeSync(reqFd);
      }
    }
    // spawnSync is intentionally synchronous: sudo on macOS reads the TTY
    // credential cache via ttyname(3), which only works when stdin is a real
    // TTY (not a pipe). Keeping this call synchronous avoids sending it to a
    // worker thread or turning it into an async operation that would require
    // complex backpressure handling. Callers that want non-blocking sudo should
    // use SudoWorkerSession (spawn-based) rather than this one-shot path.
    result = spawnSync(
      'sudo',
      [
        // -E: forward AVANTI_WORKER_NONCE to the worker so it can verify the
        // nonce embedded in the first stdin line. Required only for the stdin
        // (named-user) path; the req-file (root) path does not use a nonce.
        ...(reqPath ? [] : ['-E']),
        ...sudoUserArgs(sudo),
        nodeExec,
        resolvedWorkerPath,
        ...(reqPath ? [`--req-file=${reqPath}`] : []),
      ],
      reqPath
        ? {
            stdio: ['inherit', 'pipe', 'inherit'],
            encoding: 'utf8',
            maxBuffer: 150 * 1024 * 1024,
          }
        : {
            // Prepend the nonce as the first line; the worker consumes it before
            // processing JSON ops (see stdinNonceVerified in privileged-worker.ts).
            input: stdinNonce + '\n' + reqPayload,
            env: { ...process.env, AVANTI_WORKER_NONCE: stdinNonce },
            stdio: ['pipe', 'pipe', 'inherit'],
            encoding: 'utf8',
            maxBuffer: 150 * 1024 * 1024,
          },
    );
  } finally {
    if (reqTmpDir) {
      try {
        fs.rmSync(reqTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
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
          // Clamp to ops.length: trim oversized responses (worker bug) and pad
          // undersized ones so callers always receive exactly ops.length results.
          const padded: WorkerResult[] = [...partial.results].slice(
            0,
            ops.length,
          );
          while (padded.length < ops.length) {
            padded.push({
              ok: false,
              error: 'worker exited before processing this op',
            });
          }
          // Non-zero exit always signals a crash, even when the partial results
          // look complete (all ops done but exception fired before writeResponse).
          // Append a sentinel so callers are not fooled into treating a crashed
          // batch as a successful one. The caller's continueOnError loop uses the
          // first ok:false entry's error field — this sentinel is last, so it
          // is only surfaced when all ops appeared to succeed.
          padded.push({
            ok: false,
            error: `privileged worker exited non-zero (${result.status ?? `signal ${result.signal}`}) after completing all ops`,
          });
          return padded;
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
    if (!result.stdout) {
      throw new Error(
        'privileged worker exited 0 but wrote no output (called process.exit(0) without writeResponse)',
      );
    }
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

  // Group ops into separate per-identity write and chmod maps so the dispatch
  // loop never slices by count. Using two maps eliminates the implicit ordering
  // invariant (write ops must precede chmod ops in a shared array) that a future
  // refactor could silently violate.
  const writeGroups = new Map<true | string, WriteOp[]>();
  const chmodGroups = new Map<true | string, WriteOp[]>();
  for (const { sudo, op } of targetOps) {
    addToGroup(writeGroups, sudo, op);
  }
  for (const t of chmodTargets) {
    const op: WriteOp = {
      type: 'chmod',
      targetPath: t.targetPath,
      mode: t.mode,
    };
    addToGroup(chmodGroups, t.sudo, op);
  }

  // Collect all sudo identities that have either write or chmod ops.
  const sudoIds = new Set<true | string>([
    ...writeGroups.keys(),
    ...chmodGroups.keys(),
  ]);

  let chmodApplied = 0;
  for (const sudo of sudoIds) {
    const writeOps = writeGroups.get(sudo) ?? [];
    const chmodOps = chmodGroups.get(sudo) ?? [];

    const session = sessions?.get(sudo);
    if (writeOps.length > 0) {
      let writeResults: WorkerResult[];
      if (session) {
        writeResults = await session.exec(writeOps);
      } else {
        // No session: fall back to a one-shot spawnSync call. This bypasses the
        // single-sudo-prompt guarantee (one spawnSync per identity per call) and
        // silently re-prompts if sudo credential caching is disabled. All production
        // callers (pull, reset, revert) open sessions via openPrivilegedSessions;
        // this branch exists for callers that skip session management (e.g. tests).
        writeResults = runPrivilegedWorker(sudo, writeOps, false);
      }
      for (const r of writeResults) {
        if (!r.ok) throw new Error(r.error ?? 'privileged worker op failed');
      }
    }
    if (chmodOps.length > 0) {
      let chmodResults: WorkerResult[];
      if (session) {
        // continueOnError=true: a chmod failure must not abort subsequent
        // chmod ops in the same batch (e.g. when multiple files have mode drift).
        try {
          chmodResults = await session.exec(chmodOps, true);
        } catch (chmodSessionErr) {
          // Worker crashed between the write exec() call and this chmod exec()
          // call. The writes are already committed on disk; only permissions are
          // affected. Warn per-file rather than propagating as a write failure.
          const msg =
            chmodSessionErr instanceof Error
              ? chmodSessionErr.message
              : String(chmodSessionErr);
          for (const co of chmodOps) {
            console.warn(
              `Warning: could not apply chmod to ${co.targetPath}: ${msg}. File content is correct; permissions will re-drift.`,
            );
          }
          continue;
        }
      } else {
        // No session: fall back to a one-shot spawnSync call. This bypasses the
        // single-sudo-prompt guarantee (one spawnSync per identity per call) and
        // silently re-prompts if sudo credential caching is disabled. All production
        // callers (pull, reset, revert) open sessions via openPrivilegedSessions;
        // this branch exists for callers that skip session management (e.g. tests).
        chmodResults = runPrivilegedWorker(sudo, chmodOps, true);
      }
      // Detect crash sentinel: when continueOnError=true and the worker exits
      // non-zero after completing all N ops, it appends a (N+1)th result with
      // ok:false. Surface it explicitly rather than masking it as a spurious
      // "chmod failed for undefined" warning.
      if (chmodResults.length > chmodOps.length) {
        const sentinel = chmodResults[chmodOps.length];
        if (sentinel && !sentinel.ok) {
          throw new Error(
            `privileged chmod worker crashed after completing all ops: ${sentinel.error ?? 'unknown'}`,
          );
        }
      }
      for (let ci = 0; ci < chmodOps.length; ci++) {
        const r = chmodResults[ci];
        if (!r) break;
        if (r.ok && !r.skipped) chmodApplied++;
        else if (!r.ok)
          console.warn(
            `Warning: chmod failed for ${chmodOps[ci].targetPath}: ${r.error ?? 'unknown error'}`,
          );
      }
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
      // No-session fallback: see the note in sudoAtomicWrite — bypasses the
      // single-prompt guarantee; only used by callers that skip openPrivilegedSessions.
      const results: WorkerResult[] = session
        ? await session.exec(ops, true)
        : runPrivilegedWorker(sudo, ops, true);
      const failed: string[] = [];
      // Iterate paths (not results) to avoid an off-by-one when continueOnError
      // appends a crash sentinel (N+1 results for N ops). paths[i] is always
      // defined; results[i] may be the sentinel and must be bounds-checked.
      paths.forEach((p, i) => {
        const r = results[i];
        if (r?.ok) {
          succeeded.add(p);
        } else if (bestEffort) {
          console.warn(
            `Warning: privileged operation failed: ${r?.error ?? 'unknown error'}`,
          );
        } else {
          failed.push(`${p}: ${r?.error ?? 'unknown error'}`);
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
    // No-session fallback: see the note in sudoAtomicWrite — bypasses the
    // single-prompt guarantee; only used by callers that skip openPrivilegedSessions.
    // Scale timeout with batch size: 2 s per read op keeps large batches
    // (e.g. 50 × 2 MiB files) from timing out on slow or encrypted filesystems.
    // The 30 s minimum covers small batches and one-off file reads.
    const readTimeoutMs = Math.max(30_000, ops.length * 2_000);
    const results: Array<{
      ok: boolean;
      contentB64?: string;
      isSymlink?: boolean;
      error?: string;
      code?: string;
    }> = session
      ? await session.exec(ops, true, readTimeoutMs)
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
    // When continueOnError is true, runPrivilegedWorker appends a crash sentinel
    // (N+1 results for N ops) when the worker exits non-zero after completing all
    // ops. The forEach above iterates items (length N), so the sentinel at index N
    // is never visited. Detect and surface it so callers are not left with a
    // complete-looking result map that silently followed an abnormal worker exit.
    if (results.length > items.length) {
      const sentinel = results[items.length];
      if (sentinel && !sentinel.ok) {
        throw new Error(
          `privileged reader crashed after completing all ops: ${sentinel.error ?? 'unknown'}`,
        );
      }
    }
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
    {
      exists: boolean;
      isSymlink: boolean;
      isDirectory: boolean;
      /** true for FIFOs, sockets, and device nodes — must not be overwritten */
      isSpecialFile: boolean;
      mode?: string;
      /** base64-encoded file or symlink-target content from the stat-read op */
      contentB64?: string;
    }
  >
> {
  const result = new Map<
    string,
    {
      exists: boolean;
      isSymlink: boolean;
      isDirectory: boolean;
      isSpecialFile: boolean;
      mode?: string;
      contentB64?: string;
    }
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
      targetPath: path.resolve(item.filePath),
    }));
    const session = sessions?.get(sudo);
    // Scale timeout with batch size: 2 s per stat-read op keeps large batches
    // (e.g. 20+ lstatFailed paths on slow/encrypted filesystems) from timing out
    // while sudoAtomicRead with identical logic would succeed. The 30 s minimum
    // covers small batches and one-off stat checks.
    const statTimeoutMs = Math.max(30_000, ops.length * 2_000);
    let results: WorkerResult[];
    if (session) {
      results = await session.exec(ops, true, statTimeoutMs);
    } else {
      // No-session fallback: see the note in sudoAtomicWrite — bypasses the
      // single-prompt guarantee; only used by callers that skip openPrivilegedSessions.
      results = runPrivilegedWorker(sudo, ops, true);
    }
    items.forEach((item, j) => {
      const r = results[j];
      const isSymlink = !!(r?.ok && r.isSymlink === true);
      const isDirectory = !!(r && !r.ok && r.code === 'EISDIR');
      const isSpecialFile = !!(r && !r.ok && r.code === 'ENOTREGFILE');
      const exists = !!(r?.ok || isDirectory || isSpecialFile);
      // EACCES/EPERM: named-user worker cannot traverse a parent directory.
      // Treat as non-existent (exists=false) so the pull proceeds — same
      // behaviour as sudoAtomicRead which maps these to null. The worker's
      // checkAncestorsSafeAsRoot re-validates ancestry at write time.
      // Unexpected error codes (EIO, ESTALE, EREMOTE, …) must not be silently
      // mapped to exists=false: that would treat the target as a new file and
      // skip v0 capture, permanently breaking `avanti revert` with no warning.
      const isPermDenied = !!(
        r &&
        !r.ok &&
        (r.code === 'EACCES' || r.code === 'EPERM')
      );
      if (
        r &&
        !r.ok &&
        !isDirectory &&
        !isSpecialFile &&
        !isPermDenied &&
        r.code !== 'ENOENT'
      ) {
        throw new Error(
          `stat-read failed for ${item.filePath}: ${r.error ?? r.code ?? 'unknown error'}`,
        );
      }
      result.set(item.filePath, {
        exists: isPermDenied ? false : exists,
        isSymlink: isPermDenied ? false : isSymlink,
        isDirectory: isPermDenied ? false : isDirectory,
        isSpecialFile: isPermDenied ? false : isSpecialFile,
        mode: r?.mode,
        contentB64: isPermDenied ? undefined : r?.contentB64,
      });
    });
    // When continueOnError is true, runPrivilegedWorker appends a crash
    // sentinel (N+1 results for N ops) when the worker exits non-zero after
    // completing all ops. The forEach above iterates items (length N), so the
    // sentinel at index N is never visited. Detect and surface it so callers
    // are not left with a complete-looking result map that silently followed
    // an abnormal worker exit.
    if (results.length > items.length) {
      const sentinel = results[items.length];
      if (sentinel && !sentinel.ok) {
        throw new Error(
          `privileged stat-reader crashed after completing all ops: ${sentinel.error ?? 'unknown'}`,
        );
      }
    }
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
    timeout: 5000,
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
    if (namedUid !== undefined) {
      trusted.add(namedUid);
    } else {
      console.warn(
        `avanti: warning — could not resolve UID for sudo user "${sudo}" (id -u failed). ` +
          `Ancestor-directory ownership checks may reject paths owned by ${sudo}. ` +
          `Ensure the user exists and the "id" command is available.`,
      );
    }
  }
  return trusted;
}

export class SudoWorkerSession {
  private proc?: ReturnType<typeof spawn>;
  private server?: net.Server;
  private ipcSocket?: net.Socket;
  private dataIn?: net.Socket;
  private tmpDir?: string;
  private ipcSocketPath?: string;
  private rl?: readline.Interface;
  private pending: {
    resolve: (results: WorkerResult[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private closed = false;
  // Resolves when the worker has connected to the IPC socket and the session
  // is ready for exec() calls. Rejects on spawn error or listen error.
  private ready: Promise<void>;
  readonly trustedUids: Set<number>;
  readonly sudo: true | string;

  constructor(sudo: true | string) {
    if (process.platform === 'win32')
      throw new Error('sudo is not supported on Windows');
    this.sudo = sudo;
    this.trustedUids = buildTrustedUids(sudo);

    const { nodeExec, resolvedWorkerPath } = prepareWorkerExec(sudo);

    // Random nonce: passed to the worker via --nonce= and echoed back as its
    // first IPC line. Verifies the connecting process is the worker we spawned
    // (defense-in-depth for the named-user case where the socket is 0666).
    const ipcNonce = crypto.randomBytes(32).toString('hex');

    // Use a Unix domain socket for IPC so that sudo's fd table is unaffected.
    // The previous approach passed fd 3 via a pipe and used `sudo -C 4` to
    // prevent sudo's closefrom from closing that fd. But `sudo -C` requires
    // `closefrom_override` in sudoers, which is disabled by default on Linux
    // and macOS — making the session fail with "not permitted to use the -C
    // option" on virtually all real installations. A Unix socket has no fd
    // that needs to survive sudo's closefrom, so no sudoers changes are needed.
    //
    // The IPC socket is always placed inside a per-session private directory.
    // For root sudo: mode 0700 — no other user can reach the socket at all.
    // For named-user sudo: mode 0711 — the target user must traverse the dir
    // to connect. The staged binary dir is shared (module-level cache) and
    // separate from the IPC dir, so each session has an independent IPC dir
    // that is cleaned up on close() without disturbing other sessions.
    //
    // net.Server.listen() creates the socket with mode 0777 & ~umask (typically
    // 0755 — world-connectable) before our chmodSync runs. For root sudo (0700),
    // no other user can reach the socket at all. For named-user sudo (0711), the
    // directory prevents filesystem enumeration but /proc/net/unix on Linux
    // reveals the full socket path to any local user.
    //
    // The nonce (256-bit random) is the primary guard against a rogue process
    // connecting first. It is passed to the worker via AVANTI_WORKER_NONCE env
    // (not cmdline) because /proc/<pid>/cmdline is world-readable on Linux,
    // while /proc/<pid>/environ is readable only by the process owner. The parent
    // uses `sudo -E` to forward the env var; this requires that the invoking
    // user's sudoers entry does not set `!setenv`. A full mitigation would use
    // SO_PEERCRED/SCM_CREDENTIALS (Linux-only) to verify the connecting PID.
    //
    // Note: there is a brief race between listen() and chmodSync() during which
    // the socket is world-connectable. On Linux, combined with /proc/net/unix
    // path visibility, a rogue local user could connect in this window — but
    // without the nonce (not yet in any process's cmdline at that point, since
    // the worker is spawned after chmodSync), so the handshake will reject them.
    {
      // mkdtemp(2) creates with mode 0700 by POSIX spec, no umask guard needed.
      const ipcDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-ipc-'));
      if (typeof sudo === 'string') {
        fs.chmodSync(ipcDir, 0o711);
      }
      stagedWorkerDirs.add(ipcDir);
      this.tmpDir = ipcDir;
    }
    this.ipcSocketPath = path.join(
      this.tmpDir,
      `ipc-${crypto.randomBytes(8).toString('hex')}.sock`,
    );
    // Add to the active-sessions set only after all synchronous setup succeeds
    // (prepareWorkerExec + mkdtempSync). If either throws (e.g. ENOSPC), the
    // session is never added and the SIGTERM handler never sees a half-constructed
    // object whose this.ready / this.proc are undefined.
    activeSudoSessions.add(this);

    let readyResolve: () => void;
    let readyReject: (e: Error) => void;
    // Set to true once the worker has completed the nonce handshake and
    // readyResolve() has been called. Used to produce accurate error messages
    // in proc.on('close') — "before connecting" is wrong for post-connection crashes.
    let connected = false;
    this.ready = new Promise<void>((res, rej) => {
      // Connection timeout: if the worker never connects to the IPC socket
      // (e.g. sudo hangs on a password prompt that has no TTY, PAM deadlock,
      // or the binary is not found), await this.ready in exec() would hang
      // indefinitely — the exec() timeout fires only AFTER ready resolves.
      // Fail fast so the caller gets a clear error instead of a silent hang.
      const readyTimer = setTimeout(() => {
        this.close();
        rej(
          new Error(
            'SudoWorkerSession: privileged worker failed to connect within 30s',
          ),
        );
      }, 30_000);
      readyTimer.unref();
      readyResolve = () => {
        clearTimeout(readyTimer);
        res();
      };
      readyReject = (err: Error) => {
        clearTimeout(readyTimer);
        rej(err);
      };
    });
    // Suppress unhandledRejection if the worker fails before exec() attaches
    // a .catch() via await this.ready. exec() will re-reject via its own promise.
    this.ready.catch(() => {});

    this.server = net.createServer({ allowHalfOpen: true });
    // Use server.on (not server.once) so a rogue process that connects before
    // the worker cannot take the single slot, close the server, and prevent the
    // real worker from connecting. ipcSocket is only assigned after the nonce
    // handshake succeeds; any connection that fails the nonce check is destroyed
    // and the server keeps listening. Once the real worker connects and verifies
    // its nonce, subsequent connections are rejected immediately.
    this.server.on('connection', (socket) => {
      if (this.ipcSocket) {
        // A verified IPC connection already exists — reject any late arrivals.
        socket.destroy();
        return;
      }

      // Destroy any connection that does not complete the nonce handshake within
      // 5 seconds. Without this, a rogue local process could connect to the
      // named-user socket (mode 0666) and hold it open indefinitely, exhausting
      // file descriptors or blocking the real worker from the verified slot.
      const authTimeout = setTimeout(() => {
        socket.destroy();
      }, 5000);
      authTimeout.unref();
      socket.once('close', () => clearTimeout(authTimeout));

      socket.on('error', (err) => {
        clearTimeout(authTimeout);
        if (this.ipcSocket === socket) {
          const p = this.pending;
          this.pending = null;
          this.close();
          p?.reject(err);
        } else {
          // Pre-nonce socket errored; just destroy it.
          socket.destroy();
        }
      });

      // Guard against OOM: readline buffers each newline-delimited response
      // entirely in memory before emitting 'line'. Cap the in-flight bytes at
      // 500 MiB (the runPrivilegedWorker one-shot path caps maxBuffer at
      // 150 MiB for comparison). Track raw socket bytes; reset after each
      // complete line so the cap applies per-response, not per-session.
      let pendingResponseBytes = 0;
      const MAX_RESPONSE_BYTES = 500 * 1024 * 1024;
      socket.on('data', (chunk: Buffer) => {
        pendingResponseBytes += chunk.length;
        if (pendingResponseBytes > MAX_RESPONSE_BYTES) {
          const p = this.pending;
          this.pending = null;
          this.close();
          p?.reject(
            new Error(
              `IPC response exceeded 500 MiB limit — split large read batches into smaller exec() calls`,
            ),
          );
        }
      });
      const rl = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
      });
      // The first line from the worker must be the nonce that was passed via
      // --nonce= on the command line. This verifies the connecting process is
      // the worker we spawned (not a rogue process that won the race to connect
      // to the named-user sudo socket before the worker did).
      let nonceVerified = false;
      rl.on('line', (line: string) => {
        pendingResponseBytes = 0;
        const trimmed = line.trim();
        if (!trimmed) {
          // Blank line before nonce verification: rogue connection probing for
          // FD exhaustion. Disconnect immediately rather than waiting for authTimeout.
          if (!nonceVerified) {
            clearTimeout(authTimeout);
            rl.close();
            socket.destroy();
          }
          return;
        }
        if (!nonceVerified) {
          const trimmedBuf = Buffer.from(trimmed);
          const nonceBuf = Buffer.from(ipcNonce);
          const nonceMatch =
            trimmedBuf.length === nonceBuf.length &&
            crypto.timingSafeEqual(trimmedBuf, nonceBuf);
          if (!nonceMatch) {
            clearTimeout(authTimeout);
            rl.close();
            socket.destroy();
            return;
          }
          nonceVerified = true;
          // Nonce verified — promote this socket to the active IPC channel.
          clearTimeout(authTimeout);
          this.ipcSocket = socket;
          this.dataIn = socket;
          this.rl = rl;
          this.server!.close();
          connected = true;
          readyResolve();
          return;
        }
        try {
          const response = JSON.parse(trimmed) as WorkerResponse;
          if (!response || !Array.isArray(response.results)) {
            throw new Error('malformed response: missing results array');
          }
          const p = this.pending;
          this.pending = null;
          p?.resolve(response.results);
        } catch (e) {
          if (this.pending !== null) {
            const p = this.pending;
            this.pending = null;
            this.close();
            p.reject(
              new Error(
                `failed to parse worker response: ${(e as Error).message}`,
              ),
            );
          } else {
            // Unexpected non-JSON line with no op in flight — likely a stray
            // debug print. Don't destroy the session; log and continue.
            console.warn(
              `avanti: unexpected line from privileged worker (no op in flight): ${(e as Error).message}`,
            );
          }
        }
      });

      // Guard against a worker that closes its socket while still alive (e.g.
      // an unhandled exception that drains and closes streams before the process
      // exits). proc.on('close') handles the normal crash path, but if the
      // socket EOF arrives first and no 'close' handler is registered here,
      // this.pending is never settled and exec() hangs for the full timeout.
      rl.on('close', () => {
        // Skip teardown for connections that closed before nonce verification
        // (this.ipcSocket is undefined until nonce is verified, so
        // this.ipcSocket !== socket would be true and incorrectly fall through).
        if (!nonceVerified || this.ipcSocket !== socket) return;
        const p = this.pending;
        this.pending = null;
        this.close();
        p?.reject(
          new Error('SudoWorkerSession: IPC stream closed without a response'),
        );
      });
    });

    this.server.once('error', (err) => {
      this.close();
      readyReject(err);
    });

    this.server.listen(this.ipcSocketPath, () => {
      // Guard against a close() that arrived while the listen I/O was pending.
      // close() nulls ipcSocketPath (and sets this.closed), so chmodSync and
      // spawn would receive undefined without this check.
      if (this.closed) return;
      // Server is listening — now safe to spawn the worker so it cannot miss
      // the listening socket. Set socket permissions: root sudo needs 0600
      // (only invoking user can connect); named-user sudo needs 0666 so the
      // target user can connect regardless of group membership. For named-user
      // sudo, the ipcDir has mode 0711 (world-traversable, not world-listable)
      // to prevent filesystem enumeration of the socket filename. Note that
      // /proc/net/unix can still reveal the path to local users. The nonce
      // handshake (passed via env, not cmdline) is the primary defense; a rogue
      // process connecting during the brief listen→chmod race window cannot know
      // the nonce because the worker is spawned after chmodSync completes.
      try {
        fs.chmodSync(
          this.ipcSocketPath!,
          typeof sudo === 'string' ? 0o666 : 0o600,
        );
      } catch (e) {
        // chmod failure leaves the socket world-connectable (0777&~umask,
        // typically 0755); any local user can connect and attempt to
        // authenticate. Abort unconditionally — the same risk applies whether
        // the worker runs as root or as a named user, and the nonce alone is
        // not sufficient when the socket is reachable by arbitrary processes.
        // Reject ready rather than throwing so this async callback does not
        // propagate an uncaughtException that would crash the parent process.
        readyReject(e instanceof Error ? e : new Error(String(e)));
        this.close();
        return;
      }

      // Open /dev/tty so that sudo can look up cached credentials via
      // ttyname(STDIN_FILENO). When stdin is a pipe, macOS sudo's ttyname()
      // returns NULL and ignores the credential cache, forcing a re-prompt.
      // Fall back to 'inherit' when no controlling TTY is available (CI, containers).
      let ttyFd: number | undefined;
      try {
        ttyFd = fs.openSync('/dev/tty', 'r+');
      } catch {
        /* no controlling TTY */
      }

      try {
        this.proc = spawn(
          'sudo',
          [
            // -E: forward AVANTI_WORKER_NONCE from the parent env to the worker.
            // This requires the invoking user's sudoers entry to allow setenv
            // (i.e. not have !setenv). If denied, sudo exits non-zero before the
            // worker starts and exec() rejects via the proc.on('close') handler.
            '-E',
            ...sudoUserArgs(sudo),
            nodeExec,
            resolvedWorkerPath,
            `--socket-path=${this.ipcSocketPath!}`,
          ],
          {
            // Pass the nonce via env so it does not appear in /proc/<pid>/cmdline
            // (world-readable on Linux). /proc/<pid>/environ is owner-readable only.
            env: { ...process.env, AVANTI_WORKER_NONCE: ipcNonce },
            // stdin: /dev/tty (or inherited) so sudo's ttyname() succeeds
            // stdout/stderr: ignored — all IPC goes through the Unix socket
            stdio: [ttyFd ?? 'inherit', 'ignore', 'inherit'],
            // detached: sudo becomes a new process group leader so that
            // close() can kill the entire group (-pid) including the node
            // worker child on platforms where sudo forks rather than exec()s
            // (e.g. macOS with PAM). The inherited /dev/tty fd on stdin still
            // reaches sudo for password prompts even in the new session.
            detached: true,
          },
        );
      } catch (spawnErr) {
        readyReject(
          spawnErr instanceof Error ? spawnErr : new Error(String(spawnErr)),
        );
        this.close();
        return;
      } finally {
        if (ttyFd !== undefined) {
          try {
            fs.closeSync(ttyFd);
          } catch {
            // ignore
          }
        }
      }

      this.proc.on('error', (err) => {
        // Null proc before close() so close() does not SIGTERM a process that
        // has already reported a spawn error — mirrors the 'close' handler.
        // Note: this.pending is always null here — spawn errors fire before the
        // process starts, so exec() is still suspended at `await this.ready`
        // and has not yet assigned this.pending. Only readyReject reaches the
        // exec() caller; close() handles the session cleanup.
        this.proc = undefined;
        this.close();
        readyReject(err);
      });

      this.proc.on('close', (code, signal) => {
        // Null proc before calling close() so close() does not attempt to
        // kill a process that has already exited.
        this.proc = undefined;
        const p = this.pending;
        // Do NOT null this.pending yet. The readline 'line' event for the
        // worker's JSON response may be queued in the same event-loop iteration
        // as this SIGCHLD-triggered close event. Nulling this.pending here
        // would prevent the line handler from resolving the promise even though
        // the response data is already buffered. setImmediate defers the reject
        // until after all I/O callbacks in the current iteration have run,
        // giving readline one tick to fire the 'line' event first.
        setImmediate(() => {
          // If readline processed the response in the current tick, it set
          // this.pending to null (or to a new promise for a concurrent exec —
          // but concurrent exec is guarded against). Only reject if the promise
          // object is still the one we captured.
          const readyErr = new Error(
            connected
              ? code !== null
                ? `privileged worker crashed after connecting (exit ${code})`
                : `privileged worker killed after connecting (signal ${signal ?? 'unknown'})`
              : code !== null
                ? `privileged worker failed before connecting (exit ${code})`
                : `privileged worker killed before connecting (signal ${signal ?? 'unknown'})`,
          );
          if (this.pending === p) {
            this.pending = null;
            this.close();
            if (p) {
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
          } else if (!this.closed) {
            this.close();
          }
          // If no connection was established yet, reject the ready promise so
          // that exec() does not hang waiting for a worker that will never
          // connect. readyReject is a no-op if the promise already resolved.
          readyReject(readyErr);
        });
      });
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

    // Wait for the worker to connect (no-op after first call once ready resolves).
    // If ready rejects (spawn failure, connection timeout, listen error), close()
    // here so the session is not left in the activeSudoSessions set as a zombie.
    try {
      await this.ready;
    } catch (e) {
      this.close();
      throw e;
    }
    // Re-check after awaiting: the connection timeout or an external close()
    // may have fired while this call was suspended, leaving this.dataIn undefined.
    if (this.closed) throw new Error('SudoWorkerSession: session is closed');
    // Re-check pending after the await: two concurrent exec() calls both see
    // pending===null before the await, both yield here, then both resume. The
    // second to resume finds pending already set by the first.
    if (this.pending)
      throw new Error(
        'SudoWorkerSession: concurrent exec() calls are not supported',
      );

    return new Promise<WorkerResult[]>((resolve, reject) => {
      // `settled` is per-exec: once true, neither the timeout nor the response
      // handler can act. This prevents a rapid second exec() from being wrongly
      // timed out: the first timer sees settled=true (set by the response) and
      // exits without touching this.pending or closing the session.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending = null;
        if (!this.closed) this.close();
        reject(new Error('SudoWorkerSession: exec() timed out'));
      }, timeoutMs);
      this.pending = {
        resolve: (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Clear pending before close() so close() does not reject with the
          // generic "session closed" message and swallow the detail error.
          this.pending = null;
          if (r.length !== ops.length) {
            if (continueOnError) {
              // Crash-after-completion sentinel: the worker appends exactly one
              // extra {ok:false} entry via emitErrorAndExit AFTER all N ops
              // completed. Preserve the N+1 array so callers can detect it via
              // results.length > ops.length — slicing it away would leave them
              // with a complete-looking result set that silently followed a
              // non-zero worker exit (the bug reported against sudoAtomicRead).
              if (r.length === ops.length + 1) {
                const maybeSentinel = r[ops.length];
                if (maybeSentinel && !maybeSentinel.ok) {
                  resolve([...r]); // N+1 array; sentinel at index ops.length
                  return;
                }
              }
              // General: worker crashed mid-batch — clamp to ops.length and pad
              // unprocessed tail ops so callers always receive exactly ops.length
              // results and can distinguish completed ops from those that never ran.
              const padded: WorkerResult[] = [...r].slice(0, ops.length);
              while (padded.length < ops.length) {
                padded.push({
                  ok: false,
                  error: 'worker exited before processing this op',
                });
              }
              // Do NOT call this.close() here: the caller (e.g. sudoAtomicWrite)
              // may have a subsequent exec() call (e.g. chmod ops after write ops)
              // that must be able to detect the session state via its own error
              // rather than an abrupt "session is closed" from a preemptive close.
              // The worker exiting will close the socket naturally, causing the
              // readline 'close' event to fire and reject any pending exec().
              resolve(padded);
            } else {
              const firstFailed = r.find((x) => !x.ok);
              const detail =
                firstFailed?.error ??
                `privileged worker returned ${r.length} results, expected ${ops.length}`;
              this.close();
              reject(new Error(detail));
            }
          } else {
            resolve(r);
          }
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        },
      };
      const request: WorkerRequest = {
        ops,
        continueOnError,
      };
      try {
        this.dataIn!.write(JSON.stringify(request) + '\n', (err) => {
          if (err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Null pending first so close() does not double-reject with
            // "session closed" and swallow the real write error.
            this.pending = null;
            this.close();
            reject(err);
          }
        });
      } catch (writeErr) {
        // socket.write() can throw synchronously on a destroyed socket
        // (ERR_STREAM_DESTROYED). Guard with settled so the timer does not
        // also fire after we reject — it would otherwise linger for timeoutMs.
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.pending = null;
          this.close();
          reject(
            writeErr instanceof Error ? writeErr : new Error(String(writeErr)),
          );
        }
      }
    });
  }

  close(): void {
    if (this.closed) return;
    const p = this.pending;
    this.pending = null;
    this.closed = true;
    activeSudoSessions.delete(this);
    p?.reject(new Error('SudoWorkerSession: session closed'));
    this.rl?.close();
    this.rl = undefined;
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // server.close() throws ERR_SERVER_NOT_RUNNING if already closed
        // (e.g. called after the connection handler already stopped it)
      }
      this.server = undefined;
    }
    this.ipcSocket?.destroy();
    this.ipcSocket = undefined;
    this.dataIn = undefined;
    if (this.ipcSocketPath) {
      try {
        fs.unlinkSync(this.ipcSocketPath);
      } catch {
        // best-effort; already removed by tmpDir cleanup or never created
      }
      this.ipcSocketPath = undefined;
    }
    if (this.proc) {
      const pid = this.proc.pid;
      if (pid !== undefined) {
        // Kill the entire process group: sudo was spawned with detached:true so
        // it is the process group leader. -pid targets both sudo and its node
        // worker child (on macOS where sudo forks rather than exec()s). On Linux
        // sudo typically exec()s so proc.pid == worker pid and -pid == proc.pid.
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // Process group may already be gone; fall back to direct kill.
          this.proc.kill('SIGTERM');
        }
        const t = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // ignore; process group likely already gone
          }
        }, 5_000);
        t.unref();
        this.proc.once('close', () => clearTimeout(t));
      }
    }
    if (this.tmpDir) {
      cleanupWorkerDir(this.tmpDir);
      this.tmpDir = undefined;
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
          // Symlink target is unreadable without root. We cannot check the target
          // directory's mode or owner, but we CAN (and must) validate the symlink
          // owner before returning. An untrusted UID owns the symlink and can
          // atomically swap it between our preflight and the worker's write,
          // redirecting privileged writes. ownerUid was already captured from
          // lstatSync above — validate it now before returning early.
          if (trustedUids !== undefined && !trustedUids.has(ownerUid)) {
            throw new Error(
              `sudo write: ${label} directory ${absDir} symlink is owned by UID ${ownerUid}, ` +
                `not a trusted identity; cannot safely create a temp file here (TOCTOU risk).`,
              { cause: e2 },
            );
          }
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
    // on machines with timestamp_timeout=0. Skip here; the privileged worker's
    // checkAncestorsSafeAsRoot (runs as root, no EACCES constraint) re-validates
    // ALL ancestors at write time before touching any file.
    //
    // Accepted residual race: an attacker who owns the EACCES ancestor (trusted
    // UID) could make it world-writable, plant a malicious rename target inside,
    // then remove the world-writable bit — all in the window between this skip
    // and the worker's re-check. The worker's check catches the world-writable
    // bit only if it is still set when the check runs. Exploiting this requires
    // owning a trusted-UID ancestor AND winning a sub-millisecond timing race
    // against both the parent and the worker; accepted as a residual risk.
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

// Collects ancestor directories of targetPath from filesystem root down to the
// immediate parent, then calls callback for each. Mirrors the equivalent helper
// in privileged-worker.ts; both must use the same root-detection idiom
// (`anc === path.dirname(anc)`) so that any edge-case fixes stay consistent.
function walkAncestors(
  targetPath: string,
  callback: (anc: string) => void,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break; // reached filesystem root
  }
  for (const ancestor of ancestors) {
    callback(ancestor);
  }
}

// Walks every ancestor of targetPath (from the filesystem root down to its
// parent directory) and calls checkDirSafe on each. A single writable or
// untrusted-owned ancestor anywhere in the path is sufficient for a race:
// an attacker can swap that component to a symlink between the sudo preflight
// checks and the sudo mktemp/tee/mv, redirecting the privileged write.
//
// EACCES on an ancestor causes a silent pass here (see checkDirSafe for
// rationale). The worker's checkAncestorsSafeAsRoot is the authoritative check
// and re-validates every ancestor as root before touching any file.
function checkAncestorsSafe(
  sudo: true | string,
  targetPath: string,
  trustedUids: Set<number>,
  label: string,
  checkedDirs?: Set<string>,
): void {
  walkAncestors(targetPath, (ancestor) => {
    if (checkedDirs?.has(ancestor)) return;
    checkDirSafe(sudo, ancestor, trustedUids, `${label} ancestor`);
    checkedDirs?.add(ancestor);
  });
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

      // Resolve effective mode before writing so we can apply fchmodSync via
      // the fd while it is still open, eliminating the TOCTOU window that a
      // path-based chmodSync after renameSync would create.
      let effectiveMode: number | undefined;
      if (t.mode) {
        effectiveMode = parseMode(t.mode);
      } else {
        try {
          effectiveMode = fs.lstatSync(t.targetPath).mode & 0o7777;
        } catch {
          // file doesn't exist yet — leave the temp file's umask permissions
        }
      }
      stagingEntry.effectiveMode = effectiveMode;

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
        // Apply mode via fd while it is still open — sets permissions on the
        // inode without re-traversing the path (no TOCTOU between rename and chmod).
        if (effectiveMode !== undefined) {
          fs.fchmodSync(tmpFd, effectiveMode);
        }
      } finally {
        fs.closeSync(tmpFd);
      }
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
      // Mode was applied to the temp-file inode via fchmodSync before close —
      // rename(2) carries the inode with its permissions, so no path-based
      // chmod is needed here (which would reopen a TOCTOU window).
      fs.renameSync(s.tmp, s.dest);
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
        effectiveMode = parseMode(t.mode);
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
          // Apply mode via fd before close — sets permissions on the inode
          // without re-traversing the path after close (no TOCTOU).
          if (effectiveMode !== undefined) {
            fs.fchmodSync(fd, effectiveMode);
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
      // POSIX path: mode applied via fchmodSync above. Windows path: apply now
      // (O_NOFOLLOW unavailable, so O_CREAT + writeFileSync handles the mode
      // via the open(2) mode argument; the chmodSync below is belt-and-suspenders
      // for the case where the file pre-existed with different permissions).
      if (oNoFollow === 0 && effectiveMode !== undefined) {
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
