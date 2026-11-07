/** One-shot (spawnSync) invocation of the privileged worker via sudo. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'child_process';
import type { WorkerResult, WriteOp } from '../privileged-worker';
import { padResults } from './worker-results';
import {
  prepareWorkerExec,
  SUDO_PRESERVE_NONCE_ARG,
  sudoUserArgs,
} from './worker-staging';
import { WORLD_TMP } from './world-tmp';

const MAX_BUFFER = 150 * 1024 * 1024;

type OneShotResult = SpawnSyncReturns<string>;

export function runPrivilegedWorker(
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

  const result = spawnOneShotWorker(
    sudo,
    nodeExec,
    resolvedWorkerPath,
    reqPayload,
  );

  if (result.error) throw spawnFailure(result.error);
  if (result.status !== 0) {
    return handleNonZeroExit(result, ops.length, continueOnError);
  }
  const results = parseSuccessResponse(result.stdout, ops.length);
  if (!continueOnError) {
    for (const r of results) {
      if (!r.ok) throw new Error(r.error ?? 'privileged worker op failed');
    }
  }
  return results;
}

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
function spawnOneShotWorker(
  sudo: true | string,
  nodeExec: string,
  workerPath: string,
  reqPayload: string,
): OneShotResult {
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
  try {
    if (!isNamedUser) {
      reqTmpDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-req-'));
      reqPath = writeReqFile(reqTmpDir, reqPayload);
    }
    // spawnSync is intentionally synchronous: sudo on macOS reads the TTY
    // credential cache via ttyname(3), which only works when stdin is a real
    // TTY (not a pipe). Keeping this call synchronous avoids sending it to a
    // worker thread or turning it into an async operation that would require
    // complex backpressure handling. Callers that want non-blocking sudo should
    // use SudoWorkerSession (spawn-based) rather than this one-shot path.
    return spawnSync(
      'sudo',
      [
        // Forward AVANTI_WORKER_NONCE to the worker so it can verify the
        // nonce embedded in the first stdin line. Required only for the stdin
        // (named-user) path; the req-file (root) path does not use a nonce.
        ...(reqPath ? [] : [SUDO_PRESERVE_NONCE_ARG]),
        ...sudoUserArgs(sudo),
        nodeExec,
        workerPath,
        ...(reqPath ? [`--req-file=${reqPath}`] : []),
      ],
      oneShotSpawnOptions(reqPath, stdinNonce, reqPayload),
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
}

function writeReqFile(reqTmpDir: string, reqPayload: string): string {
  const reqPath = path.join(
    reqTmpDir,
    `avanti-req-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  const reqFd = fs.openSync(reqPath, 'wx', 0o600);
  try {
    fs.writeFileSync(reqFd, reqPayload);
  } finally {
    fs.closeSync(reqFd);
  }
  return reqPath;
}

function oneShotSpawnOptions(
  reqPath: string | undefined,
  stdinNonce: string | undefined,
  reqPayload: string,
): SpawnSyncOptionsWithStringEncoding {
  if (reqPath) {
    return {
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    };
  }
  return {
    // Prepend the nonce as the first line; the worker consumes it before
    // processing JSON ops (see stdinNonceVerified in privileged-worker.ts).
    input: stdinNonce + '\n' + reqPayload,
    env: { ...process.env, AVANTI_WORKER_NONCE: stdinNonce },
    stdio: ['pipe', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  };
}

function spawnFailure(error: Error): Error {
  if (
    (error as NodeJS.ErrnoException).code ===
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  ) {
    return new Error(
      'privileged worker stdout exceeded the 150 MiB maxBuffer — batch is too large; use SudoWorkerSession for large read ops',
      { cause: error },
    );
  }
  return error;
}

function handleNonZeroExit(
  result: OneShotResult,
  opCount: number,
  continueOnError: boolean,
): WorkerResult[] {
  // If continueOnError is set, the worker may have written partial results to
  // stdout before exiting (e.g. crashed after some ops completed). Return
  // them so callers can record which ops succeeded rather than losing all
  // partial state.
  if (continueOnError && result.stdout) {
    const partial = partialResultsAfterCrash(result, opCount);
    if (partial) return partial;
  }
  throw new Error(nonZeroExitMessage(result));
}

function partialResultsAfterCrash(
  result: OneShotResult,
  opCount: number,
): WorkerResult[] | undefined {
  try {
    const partial = JSON.parse(result.stdout) as {
      results: WorkerResult[];
    };
    if (Array.isArray(partial.results) && partial.results.length > 0) {
      // Clamp to ops.length: trim oversized responses (worker bug) and pad
      // undersized ones so callers always receive exactly ops.length results.
      const padded = padResults(partial.results, opCount);
      // Non-zero exit always signals a crash, even when the partial results
      // look complete (all ops done but exception fired before writeResponse).
      // Append a sentinel so callers are not fooled into treating a crashed
      // batch as a successful one. The caller's continueOnError loop uses the
      // first ok:false entry's error field — this sentinel is last, so it
      // is only surfaced when all ops appeared to succeed.
      const exitDesc = result.status ?? `signal ${result.signal}`;
      padded.push({
        ok: false,
        error: `privileged worker exited non-zero (${exitDesc}) after completing all ops`,
      });
      return padded;
    }
  } catch {
    // fall through to throw
  }
  return undefined;
}

function nonZeroExitMessage(result: OneShotResult): string {
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
  return workerError;
}

function parseSuccessResponse(stdout: string, opCount: number): WorkerResult[] {
  try {
    if (!stdout) {
      throw new Error(
        'privileged worker exited 0 but wrote no output (called process.exit(0) without writeResponse)',
      );
    }
    const parsed = JSON.parse(stdout) as {
      results: WorkerResult[];
    };
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error(
        `privileged worker returned malformed response (missing results array): ${stdout}`,
      );
    }
    const results = parsed.results;
    if (results.length !== opCount) {
      // Surface the actual failure message if an op failed early; a count
      // mismatch alone tells the caller nothing useful.
      const firstFailed = results.find((r) => !r.ok);
      throw new Error(
        firstFailed?.error ??
          `privileged worker returned ${results.length} results, expected ${opCount}`,
      );
    }
    return results;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Error(`privileged worker returned non-JSON output: ${stdout}`, {
      cause: e,
    });
  }
}
