/** Resolution of a trusted Node.js binary to run the privileged worker via sudo. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

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

// Minimum Node.js major version that can run the compiled worker.
// The worker is compiled to ES2022 (tsconfig.build.json target), which
// Node.js 18+ supports fully. Using the current process's major version
// as the threshold is wrong: when the caller runs under nvm/mise (e.g.
// v24), a system node v18 is perfectly capable of running the ES2022
// compiled output and would be rejected without cause.
const WORKER_MIN_NODE_MAJOR = 18;

// `node --version` is fast on a healthy system, but a cold start on a heavily
// loaded machine (e.g. a CI runner with many parallel test workers) can take
// several seconds. A too-short timeout kills the child, leaves stdout empty and
// makes a valid binary look missing. The resolved path is cached per sudo
// identity, so this cost is paid at most once per process.
export const NODE_VERSION_CHECK_TIMEOUT_MS = 10_000;

export type NodeVersionCheck =
  { ok: true; major: number } | { ok: false; reason: string };

// Runs `<realPath> --version` and checks it meets WORKER_MIN_NODE_MAJOR.
// Retries once on timeout. Returns a human-readable reason on failure so the
// caller can say why a candidate was rejected instead of reporting "not found".
export function checkNodeVersion(realPath: string): NodeVersionCheck {
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const vr = spawnSync(realPath, ['--version'], {
      encoding: 'utf8',
      timeout: NODE_VERSION_CHECK_TIMEOUT_MS,
    });
    const err: NodeJS.ErrnoException | undefined = vr.error;
    const errCode = err?.code;
    if (errCode === 'ETIMEDOUT' || (vr.signal && !vr.stdout)) {
      reason =
        errCode === 'ETIMEDOUT'
          ? `version check timed out after ${NODE_VERSION_CHECK_TIMEOUT_MS}ms`
          : `version check killed by ${vr.signal}`;
      continue;
    }
    if (vr.error) {
      return {
        ok: false,
        reason: `version check failed: ${errCode ?? vr.error.message}`,
      };
    }
    return parseNodeVersion((vr.stdout ?? '').toString().trim());
  }
  return { ok: false, reason };
}

function parseNodeVersion(out: string): NodeVersionCheck {
  const m = /^v(\d+)\./.exec(out);
  if (!m) {
    return {
      ok: false,
      reason: `unrecognised version output ${JSON.stringify(out.slice(0, 40))}`,
    };
  }
  const major = parseInt(m[1], 10);
  if (major < WORKER_MIN_NODE_MAJOR) {
    return {
      ok: false,
      reason: `version ${out} is older than v${WORKER_MIN_NODE_MAJOR}`,
    };
  }
  return { ok: true, major };
}

// State shared by the candidate probes of one resolveNodeExec call.
interface ProbeState {
  // Candidates that exist and are root-owned but failed the version check,
  // with the reason. Included in the final error so a timeout or old version
  // is not mistaken for a missing binary.
  rejected: string[];
  // Real paths already probed. /usr/bin/node, /usr/bin/nodejs, /bin/node and
  // process.execPath often resolve to the same file; probing it again after a
  // failure would only repeat the same (possibly slow) result.
  probed: Set<string>;
}

function isRootOwnedExecutable(st: fs.Stats): boolean {
  return st.isFile() && (st.mode & 0o111) !== 0 && st.uid === 0;
}

// Marks realPath as probed and runs the version check; returns realPath when it
// passes and records the rejection reason otherwise.
function probeVersion(realPath: string, state: ProbeState): string | undefined {
  state.probed.add(realPath);
  const check = checkNodeVersion(realPath);
  if (check.ok) return realPath;
  state.rejected.push(`${realPath}: ${check.reason}`);
  return undefined;
}

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
function resolveNodeExecOverride(exec: string): string {
  process.stderr.write(
    `avanti: WARNING — AVANTI_NODE_EXEC is set to "${exec}"; all Node.js binary security checks are bypassed. ` +
      `Only set this in controlled environments where the binary is trusted.\n`,
  );
  try {
    fs.accessSync(exec, fs.constants.X_OK);
  } catch {
    throw new Error(
      `AVANTI_NODE_EXEC is set to "${exec}" but the binary is not executable or does not exist`,
    );
  }
  return exec;
}

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
function probeProcessExecPath(state: ProbeState): string | undefined {
  try {
    const realPath = fs.realpathSync(process.execPath);
    const st = fs.statSync(realPath);
    if (
      isRootOwnedExecutable(st) &&
      !realPath.startsWith(os.homedir() + path.sep)
    ) {
      // Apply the same version floor as the SAFE_DIRS scan so that a stale
      // root-owned binary (e.g. v16) does not silently produce an opaque
      // SyntaxError inside the worker.
      // On failure, fall through to SAFE_DIRS scan.
      return probeVersion(realPath, state);
    }
  } catch {
    // ignore and fall through to SAFE_DIRS search
  }
  return undefined;
}

function probeSafeDirCandidate(
  candidate: string,
  state: ProbeState,
): string | undefined {
  try {
    const realPath = fs.realpathSync(candidate);
    const st = fs.statSync(realPath);
    // Require root ownership: on Apple Silicon, /opt/homebrew is user-owned
    // so a Homebrew-installed node binary is writable by the calling user.
    // Accepting such a binary would allow the calling user to replace it with
    // malicious code that executes as the sudo target.
    if (!isRootOwnedExecutable(st)) return undefined;
    // Version check: reject binaries older than the compiled worker requires.
    // This turns an opaque "privileged worker failed (exit 1)" SyntaxError
    // into an actionable "no compatible binary found" message.
    if (state.probed.has(realPath)) return undefined;
    return probeVersion(realPath, state);
  } catch {
    // ignore EACCES, ENOENT, and any other stat/spawn error
    return undefined;
  }
}

// Scan only known-safe system directories, not all of PATH. PATH may contain
// world-writable directories under an attacker's control; returning a binary
// from one of those would cause sudo to execute attacker code.
// sudo's secure_path would normally sanitise PATH, but spawnSync passes the
// resolved binary as argv[0], bypassing secure_path entirely.
function safeDirs(): string[] {
  return process.platform === 'darwin'
    ? ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin']
    : ['/usr/bin', '/usr/local/bin', '/bin'];
}

function scanSafeDirs(dirs: string[], state: ProbeState): string | undefined {
  for (const dir of dirs) {
    // Try both 'node' and 'nodejs': Debian/Ubuntu ship the binary as 'nodejs'.
    for (const name of ['node', 'nodejs']) {
      const found = probeSafeDirCandidate(path.join(dir, name), state);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function resolveNodeExec(sudo: true | string): string {
  const override = process.env.AVANTI_NODE_EXEC;
  if (override) return resolveNodeExecOverride(override);
  const cacheKey = sudo === true ? '__root__' : sudo;
  const cached = resolvedNodeExecCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const state: ProbeState = { rejected: [], probed: new Set<string>() };
  const SAFE_DIRS = safeDirs();
  const found = probeProcessExecPath(state) ?? scanSafeDirs(SAFE_DIRS, state);
  if (found !== undefined) {
    resolvedNodeExecCache.set(cacheKey, found);
    return found;
  }
  const sudoDesc =
    typeof sudo === 'string' ? `named-user sudo ('${sudo}')` : 'root sudo';
  const rejectedDesc =
    state.rejected.length > 0
      ? `Rejected candidates: ${state.rejected.join('; ')}. `
      : '';
  // SAFE_DIRS covers Debian/Ubuntu, macOS, and Alpine. Non-standard distros
  // (NixOS: /nix/store/…/bin/node, Guix, custom builds) may not have any
  // root-owned binary in these paths. Set AVANTI_NODE_EXEC to the absolute
  // path of any root-owned, compatible Node.js binary to bypass this scan.
  throw new Error(
    `No root-owned Node.js binary (v${WORKER_MIN_NODE_MAJOR}+) found in ${SAFE_DIRS.join(', ')} for ${sudoDesc}. ` +
      rejectedDesc +
      `On NixOS or other non-standard distros, set the AVANTI_NODE_EXEC environment variable to the absolute ` +
      `path of a root-owned, compatible Node.js binary (e.g. AVANTI_NODE_EXEC=$(readlink -f $(which node))). ` +
      `On standard distros, install Node.js system-wide (e.g. apt install nodejs, brew install node).`,
  );
}
