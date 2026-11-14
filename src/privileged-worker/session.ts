/** The worker's request loop: reads JSON batches, dispatches ops, replies. */
import * as crypto from 'crypto';
import * as readline from 'readline';
import { dispatch } from './dispatch';
import type {
  DispatchResult,
  WorkerRequest,
  WorkerResult,
  WriteOp,
} from './types';
import { checkOpAncestors, validateOp } from './validate-op';

const MAX_OPS = 10_000;

interface Session {
  rl: readline.Interface;
  inputStream: NodeJS.ReadableStream;
  outputStream: NodeJS.WritableStream;
  stdinNonceVerified: boolean;
  // In-progress batch state: updated by the line handler as ops complete.
  // emitErrorAndExit reads these to include completed results in the crash
  // response, so callers can distinguish ops that finished OK from those that
  // never ran (rather than reporting all as "exited before processing").
  batchResults: WorkerResult[] | null;
  batchExpectedOps: number;
}

function writeResponse(session: Session, obj: unknown, cb?: () => void): void {
  session.outputStream.write(JSON.stringify(obj) + '\n', cb);
}

// Do NOT .unref() this timer: if outputStream is a destroyed socket the
// write callback may never fire, leaving the event loop empty. Without a
// ref'd timer the process would exit 0 before this fires and the crash
// result would never reach the parent. 100 ms is negligible.
function exitSoon(): void {
  setTimeout(() => process.exit(1), 100);
}

// Always emit at least one {ok:false} crash entry. When remaining>0 the
// crash entries cover unprocessed ops. When remaining===0 all ops already
// completed (batchResults is full) but the exception fires before
// writeResponse() — without an extra entry the parent would receive an
// all-ok response and silently miss the crash. The sentinel is one extra
// result beyond ops.length; the parent's continueOnError handler trims to
// ops.length AFTER checking for non-zero exit, so the sentinel is visible.
function crashResults(
  msg: string,
  completed: WorkerResult[],
  total: number,
): WorkerResult[] {
  const remaining = Math.max(0, total - completed.length);
  if (completed.length === 0 && remaining === 0) {
    return [{ ok: false, error: msg }];
  }
  const padCount = Math.max(remaining, 1);
  return [
    ...completed,
    // Include the real crash message in the first padded slot so the
    // parent can surface it to the user. Subsequent padding uses the
    // generic "not yet processed" message to distinguish the crash op
    // from ops that simply never ran.
    ...Array.from({ length: padCount }, (_, i) => ({
      ok: false as const,
      error: i === 0 ? msg : 'worker exited before processing this op',
    })),
  ];
}

// Shared flush-then-exit helper used by the uncaughtException,
// unhandledRejection, and input-stream error handlers. Emits any
// already-completed results for the current batch so the parent's exec()
// receives accurate partial state rather than losing all completed ops.
// Pads the remainder with the crash error so callers always receive exactly
// batchExpectedOps results when a batch was in flight. Falls back to a
// single error result when no batch is active (e.g. crash during init).
// end() flushes buffered data and sends FIN before the process exits,
// ensuring the parent's readline sees the JSON line before the 'close' event
// fires. process.stdout cannot be end()ed (throws ERR_STDOUT_CLOSE); only
// call end() on the IPC socket path. The 100ms fallback timer fires if the
// write callback is never called (e.g. the socket was already torn down).
function emitErrorAndExit(session: Session, msg: string): void {
  try {
    const allResults = crashResults(
      msg,
      session.batchResults ?? [],
      session.batchExpectedOps,
    );
    const { outputStream } = session;
    writeResponse(session, { results: allResults }, () => {
      if (outputStream !== process.stdout) {
        outputStream.end(() => process.exit(1));
      } else {
        process.exit(1);
      }
    });
    exitSoon();
  } catch {
    process.exit(1);
  }
}

// Rejects the whole request with a single error result, then exits.
function rejectRequest(session: Session, error: string): void {
  // Pause readline synchronously before any async work so buffered lines
  // from a pipelined second request are not emitted while we are exiting.
  session.rl.pause();
  writeResponse(session, { results: [{ ok: false, error }] }, () => {
    process.exit(1);
  });
  exitSoon();
}

function registerCrashHandlers(session: Session): void {
  // Shut down immediately on any unexpected error so subsequent ops are not
  // dispatched while the worker is in an unknown state.
  // Use process.once so that a second uncaught exception after writeResponse has
  // already delivered results for the current batch does not push a stale error
  // line onto the socket, which would corrupt the NEXT exec() call's readline.
  // emitErrorAndExit includes already-completed results (batchResults) so the
  // parent receives accurate partial state. Ops that had not yet started are
  // padded with "worker exited before processing this op".
  process.once('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    process.stderr.write(
      `avanti privileged-worker: uncaught exception: ${stack ?? msg}\n`,
    );
    emitErrorAndExit(session, msg);
  });
  process.once('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(
      `avanti privileged-worker: unhandled rejection: ${msg}\n`,
    );
    emitErrorAndExit(session, msg);
  });

  // Listen on the readline interface rather than inputStream: readline
  // registers its own 'error' listener on the input first and re-emits the
  // error on the interface, which throws when the interface has no listener —
  // so a handler on inputStream would never run.
  session.rl.on('error', (err: Error) => {
    process.stderr.write(`data channel error: ${err.message}\n`);
    emitErrorAndExit(session, err.message);
  });
}

function isRootWithoutSudoUid(): boolean {
  return (
    typeof process.getuid === 'function' &&
    process.getuid() === 0 &&
    !process.env.SUDO_UID
  );
}

// Compute trusted UIDs once at startup from sudo environment variables so the
// unprivileged parent cannot forge the list. Capturing here (before the line
// handler is registered) means process.env cannot be mutated between batches
// to silently expand or shrink the trusted set for subsequent requests.
// sudo sets SUDO_UID to the invoking user's real UID before elevating. The
// worker's own getuid() returns the target user's UID (0 for root-sudo).
function computeTrustedUids(): Set<number> {
  const trustedUids = new Set<number>([0]);
  // Emit an actionable error when sudo's env_reset has stripped SUDO_UID and the
  // worker is running as root. Without SUDO_UID, the trusted set only contains 0
  // and the worker's own uid; any user-owned ancestor directory (e.g. /home/alice)
  // triggers a cryptic "not trusted (TOCTOU risk)" error. Gate on getuid()==0 so
  // the check is a no-op in the test suite (which runs as a non-root user).
  if (isRootWithoutSudoUid()) {
    process.stderr.write(
      'avanti privileged-worker: SUDO_UID is not set — sudo env_reset may have stripped it.\n' +
        'Add `Defaults env_keep += "SUDO_UID"` to /etc/sudoers to allow ancestor ownership checks.\n',
    );
    process.exit(1);
  }
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid && /^\d+$/.test(sudoUid)) {
    const parsedUid = parseInt(sudoUid, 10);
    if (!isNaN(parsedUid)) {
      trustedUids.add(parsedUid);
    }
  }
  if (typeof process.getuid === 'function') {
    trustedUids.add(process.getuid());
  }
  return trustedUids;
}

// Nonce verification for the stdin path: the first line is the nonce, not a
// JSON request. Returns true when the line was consumed (as the nonce, or by
// a failed verification that is already exiting).
function consumeStdinNonce(session: Session, line: string): boolean {
  if (session.inputStream !== process.stdin || session.stdinNonceVerified) {
    return false;
  }
  const stdinNonce = process.env.AVANTI_WORKER_NONCE;
  if (!stdinNonce) {
    emitErrorAndExit(
      session,
      'stdin mode requires AVANTI_WORKER_NONCE to be set',
    );
    return true;
  }
  const lineBuf = Buffer.from(line.trim());
  const nonceBuf = Buffer.from(stdinNonce);
  if (
    lineBuf.length !== nonceBuf.length ||
    !crypto.timingSafeEqual(lineBuf, nonceBuf)
  ) {
    emitErrorAndExit(session, 'stdin nonce mismatch');
    return true;
  }
  // The !stdinNonceVerified gate already enforces single delivery:
  // after setting it true, every subsequent line skips this block entirely.
  session.stdinNonceVerified = true;
  return true; // consume this line as the nonce; wait for the next line with JSON
}

// Parses a request line; on failure rejects the request and returns undefined.
function parseRequest(
  session: Session,
  trimmed: string,
): WorkerRequest | undefined {
  let request: WorkerRequest;
  try {
    request = JSON.parse(trimmed) as WorkerRequest;
  } catch (e) {
    rejectRequest(session, `failed to parse request: ${(e as Error).message}`);
    return undefined;
  }
  if (!request || !Array.isArray(request.ops)) {
    rejectRequest(session, 'invalid request: ops must be an array');
    return undefined;
  }
  return request;
}

function toWorkerResult(dr: DispatchResult): WorkerResult {
  if (dr.kind === 'skipped') return { ok: true, skipped: true };
  if (dr.kind === 'read') {
    return {
      ok: true,
      contentB64: dr.contentB64,
      isSymlink: dr.isSymlink,
      ...(dr.mode === undefined ? {} : { mode: dr.mode }),
    };
  }
  return { ok: true };
}

function runOp(
  op: WriteOp,
  trustedUids: Set<number>,
  checkedDirs: Set<string>,
): WorkerResult {
  try {
    validateOp(op);
    checkOpAncestors(op, trustedUids, checkedDirs);
    return toWorkerResult(dispatch(op, trustedUids));
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      code: (e as NodeJS.ErrnoException).code,
    };
  }
}

function runBatch(
  session: Session,
  request: WorkerRequest,
  trustedUids: Set<number>,
): void {
  // Fresh per-batch: ancestor checks are not carried over across requests so
  // that a malicious interleaved rename cannot poison a future batch's checks.
  const checkedDirs = new Set<string>();
  const continueOnError = request.continueOnError ?? false;

  const results: WorkerResult[] = [];
  // Expose the in-progress results array so emitErrorAndExit can include
  // completed results in crash responses. batchResults is the same array
  // reference as results — pushes are visible via the reference immediately.
  session.batchResults = results;
  session.batchExpectedOps = request.ops.length;
  if (request.ops.length > MAX_OPS) {
    emitErrorAndExit(
      session,
      `ops array exceeds maximum batch size of ${MAX_OPS}`,
    );
    return;
  }
  for (const op of request.ops) {
    const result = runOp(op, trustedUids, checkedDirs);
    results.push(result);
    if (!result.ok && !continueOnError) break;
  }
  writeResponse(session, { results });
  // Batch complete — clear in-progress state so a subsequent crash (before
  // the next batch starts) does not re-emit stale results.
  session.batchResults = null;
  session.batchExpectedOps = 0;
}

/**
 * Serves JSON requests (one per line) from inputStream, writing one JSON
 * response line per request to outputStream.
 */
export function runSession(
  inputStream: NodeJS.ReadableStream,
  outputStream: NodeJS.WritableStream,
): void {
  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });
  const session: Session = {
    rl,
    inputStream,
    outputStream,
    stdinNonceVerified: false,
    batchResults: null,
    batchExpectedOps: 0,
  };

  registerCrashHandlers(session);
  const trustedUids = computeTrustedUids();

  rl.on('line', (line: string) => {
    if (consumeStdinNonce(session, line)) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const request = parseRequest(session, trimmed);
    if (request === undefined) return;
    runBatch(session, request, trustedUids);
  });

  rl.on('close', () => {
    // input stream closed — session ended naturally
  });
}
