/** Persistent privileged worker session: one sudo prompt, many exec() batches over IPC. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type * as readline from 'readline';
import type { ChildProcess } from 'child_process';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WriteOp,
} from '../privileged-worker';
import { toError } from './errors';
import {
  activeSudoSessions,
  cleanupWorkerDir,
  stagedWorkerDirs,
} from './registry';
import { acceptConnection, type IpcHost } from './session-ipc';
import { createReadyGate, type ReadyGate } from './session-ready';
import {
  spawnSessionWorker,
  terminateWorker,
  workerExitPendingMessage,
  workerExitReadyMessage,
} from './session-worker';
import { buildTrustedUids } from './trusted-uids';
import { crashSentinel, padResults } from './worker-results';
import { prepareWorkerExec } from './worker-staging';
import { WORLD_TMP } from './world-tmp';

interface PendingExec {
  resolve: (results: WorkerResult[]) => void;
  reject: (err: Error) => void;
}

const CLOSED_MESSAGE = 'SudoWorkerSession: session is closed';
const CONCURRENT_MESSAGE =
  'SudoWorkerSession: concurrent exec() calls are not supported';

export class SudoWorkerSession {
  private proc?: ChildProcess;
  private server?: net.Server;
  private ipcSocket?: net.Socket;
  private tmpDir?: string;
  private ipcSocketPath?: string;
  private rl?: readline.Interface;
  private pending: PendingExec | null = null;
  private closed = false;
  // Set to true once the worker has completed the nonce handshake and
  // the ready gate has been resolved. Used to produce accurate error messages
  // in proc.on('close') — "before connecting" is wrong for post-connection crashes.
  private connected = false;
  // Resolves with the verified IPC socket once the worker has connected and
  // the session is ready for exec() calls. Rejects on spawn error or listen
  // error.
  private readonly ready: ReadyGate<net.Socket>;
  private readonly nodeExec: string;
  private readonly workerPath: string;
  private readonly ipcNonce: string;
  private readonly socketPath: string;
  readonly trustedUids: Set<number>;
  readonly sudo: true | string;

  constructor(sudo: true | string) {
    if (process.platform === 'win32')
      throw new Error('sudo is not supported on Windows');
    this.sudo = sudo;
    this.trustedUids = buildTrustedUids(sudo);

    const { nodeExec, resolvedWorkerPath } = prepareWorkerExec(sudo);
    this.nodeExec = nodeExec;
    this.workerPath = resolvedWorkerPath;

    // Random nonce: passed to the worker via --nonce= and echoed back as its
    // first IPC line. Verifies the connecting process is the worker we spawned
    // (defense-in-depth for the named-user case where the socket is 0666).
    this.ipcNonce = crypto.randomBytes(32).toString('hex');

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
    // uses `sudo --preserve-env=AVANTI_WORKER_NONCE` to forward the env var;
    // this requires that the invoking
    // user's sudoers entry does not set `!setenv`. A full mitigation would use
    // SO_PEERCRED/SCM_CREDENTIALS (Linux-only) to verify the connecting PID.
    //
    // Note: there is a brief race between listen() and chmodSync() during which
    // the socket is world-connectable. On Linux, combined with /proc/net/unix
    // path visibility, a rogue local user could connect in this window — but
    // without the nonce (not yet in any process's cmdline at that point, since
    // the worker is spawned after chmodSync), so the handshake will reject them.

    // mkdtemp(2) creates with mode 0700 by POSIX spec, no umask guard needed.
    const ipcDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-ipc-'));
    if (typeof sudo === 'string') {
      fs.chmodSync(ipcDir, 0o711);
    }
    stagedWorkerDirs.add(ipcDir);
    this.tmpDir = ipcDir;
    this.socketPath = path.join(
      ipcDir,
      `ipc-${crypto.randomBytes(8).toString('hex')}.sock`,
    );
    this.ipcSocketPath = this.socketPath;
    // Add to the active-sessions set only after all synchronous setup succeeds
    // (prepareWorkerExec + mkdtempSync). If either throws (e.g. ENOSPC), the
    // session is never added and the SIGTERM handler never sees a half-constructed
    // object whose this.ready / this.proc are undefined.
    activeSudoSessions.add(this);

    this.ready = createReadyGate<net.Socket>(
      30_000,
      'SudoWorkerSession: privileged worker failed to connect within 30s',
      () => this.close(),
    );
    this.listen(this.ready);
  }

  // Starts the IPC server; the worker is spawned once it is listening.
  private listen(ready: ReadyGate<net.Socket>): void {
    const server = net.createServer({ allowHalfOpen: true });
    this.server = server;
    const host: IpcHost = {
      nonce: this.ipcNonce,
      hasChannel: () => this.ipcSocket !== undefined,
      isChannel: (socket) => this.ipcSocket === socket,
      promote: (socket, rl) => {
        this.ipcSocket = socket;
        this.rl = rl;
        server.close();
        this.connected = true;
        ready.resolve(socket);
      },
      abort: (err) => this.abort(err),
      handleResponse: (line) => this.handleResponse(line),
    };
    server.on('connection', (socket) => acceptConnection(socket, host));

    server.once('error', (err) => {
      this.close();
      ready.reject(err);
    });

    server.listen(this.socketPath, () => this.onListening(ready));
  }

  private onListening(ready: ReadyGate<net.Socket>): void {
    // Guard against a close() that arrived while the listen I/O was pending.
    // close() nulls ipcSocketPath (and sets this.closed), so chmodSync and
    // spawn must not run without this check.
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
        this.socketPath,
        typeof this.sudo === 'string' ? 0o666 : 0o600,
      );
    } catch (e) {
      // chmod failure leaves the socket world-connectable (0777&~umask,
      // typically 0755); any local user can connect and attempt to
      // authenticate. Abort unconditionally — the same risk applies whether
      // the worker runs as root or as a named user, and the nonce alone is
      // not sufficient when the socket is reachable by arbitrary processes.
      // Reject ready rather than throwing so this async callback does not
      // propagate an uncaughtException that would crash the parent process.
      ready.reject(toError(e));
      this.close();
      return;
    }

    let proc: ChildProcess;
    try {
      proc = spawnSessionWorker({
        sudo: this.sudo,
        nodeExec: this.nodeExec,
        workerPath: this.workerPath,
        socketPath: this.socketPath,
        nonce: this.ipcNonce,
      });
    } catch (spawnErr) {
      ready.reject(toError(spawnErr));
      this.close();
      return;
    }
    this.proc = proc;

    // Unref the child so it does not prevent the Node event loop from
    // draining after all sessions are closed (important in test environments
    // where the process should exit as soon as all work is done). close()
    // still sends SIGTERM + SIGKILL to ensure the worker exits; unref() only
    // removes the event-loop reference, not the ability to kill the process.
    proc.unref();

    proc.on('error', (err) => {
      // Null proc before close() so close() does not SIGTERM a process that
      // has already reported a spawn error — mirrors the 'close' handler.
      // Note: this.pending is always null here — spawn errors fire before the
      // process starts, so exec() is still suspended at `await this.ready`
      // and has not yet assigned this.pending. Only the ready gate reaches the
      // exec() caller; close() handles the session cleanup.
      this.proc = undefined;
      this.close();
      ready.reject(err);
    });

    proc.on('close', (code, signal) => {
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
      setImmediate(() => this.onWorkerExit(ready, p, code, signal));
    });
  }

  private onWorkerExit(
    ready: ReadyGate<net.Socket>,
    p: PendingExec | null,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // If readline processed the response in the current tick, it set
    // this.pending to null (or to a new promise for a concurrent exec —
    // but concurrent exec is guarded against). Only reject if the promise
    // object is still the one we captured.
    const readyErr = new Error(
      workerExitReadyMessage(this.connected, code, signal),
    );
    if (this.pending === p) {
      this.pending = null;
      this.close();
      if (p) {
        p.reject(new Error(workerExitPendingMessage(code, signal)));
      }
    } else if (!this.closed) {
      this.close();
    }
    // If no connection was established yet, reject the ready promise so
    // that exec() does not hang waiting for a worker that will never
    // connect. Rejecting is a no-op if the promise already resolved.
    ready.reject(readyErr);
  }

  // Closes the session and rejects the in-flight exec() (if any) with err.
  private abort(err: Error): void {
    const p = this.pending;
    this.pending = null;
    this.close();
    p?.reject(err);
  }

  private handleResponse(line: string): void {
    try {
      const response = JSON.parse(line) as WorkerResponse;
      if (!response || !Array.isArray(response.results)) {
        throw new Error('malformed response: missing results array');
      }
      const p = this.pending;
      this.pending = null;
      p?.resolve(response.results);
    } catch (e) {
      if (this.pending === null) {
        // Unexpected non-JSON line with no op in flight — likely a stray
        // debug print. Don't destroy the session; log and continue.
        console.warn(
          `avanti: unexpected line from privileged worker (no op in flight): ${(e as Error).message}`,
        );
        return;
      }
      this.abort(
        new Error(`failed to parse worker response: ${(e as Error).message}`),
      );
    }
  }

  private assertIdle(): void {
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    if (this.pending) throw new Error(CONCURRENT_MESSAGE);
  }

  async exec(
    ops: WriteOp[],
    continueOnError = false,
    timeoutMs = 30_000,
  ): Promise<WorkerResult[]> {
    this.assertIdle();

    // Wait for the worker to connect (no-op after first call once ready resolves).
    // If ready rejects (spawn failure, connection timeout, listen error), close()
    // here so the session is not left in the activeSudoSessions set as a zombie.
    let socket: net.Socket;
    try {
      socket = await this.ready.promise;
    } catch (e) {
      this.close();
      throw e;
    }
    // Re-check after awaiting: the connection timeout or an external close()
    // may have fired while this call was suspended, leaving no usable socket.
    // Re-check pending after the await: two concurrent exec() calls both see
    // pending===null before the await, both yield here, then both resume. The
    // second to resume finds pending already set by the first.
    this.assertIdle();

    return new Promise<WorkerResult[]>((resolve, reject) => {
      this.dispatch(socket, { ops, continueOnError }, timeoutMs, {
        resolve,
        reject,
      });
    });
  }

  private dispatch(
    socket: net.Socket,
    request: WorkerRequest,
    timeoutMs: number,
    caller: PendingExec,
  ): void {
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
      caller.reject(new Error('SudoWorkerSession: exec() timed out'));
    }, timeoutMs);
    // Marks this exec settled; returns false when it already was. Clears
    // pending before any close() so close() does not reject with the generic
    // "session closed" message and swallow the detail error.
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      this.pending = null;
      return true;
    };
    const fail = (err: Error): void => {
      if (!settle()) return;
      this.close();
      caller.reject(err);
    };
    this.pending = {
      resolve: (r) => {
        if (settle()) this.deliver(r, request, caller);
      },
      reject: (e) => {
        if (settle()) caller.reject(e);
      },
    };
    try {
      socket.write(JSON.stringify(request) + '\n', (err) => {
        if (err) fail(err);
      });
    } catch (writeErr) {
      // socket.write() can throw synchronously on a destroyed socket
      // (ERR_STREAM_DESTROYED). Guard with settled so the timer does not
      // also fire after we reject — it would otherwise linger for timeoutMs.
      fail(toError(writeErr));
    }
  }

  private deliver(
    r: WorkerResult[],
    request: WorkerRequest,
    caller: PendingExec,
  ): void {
    const opCount = request.ops.length;
    if (r.length === opCount) {
      caller.resolve(r);
      return;
    }
    if (request.continueOnError) {
      caller.resolve(partialResults(r, opCount));
      return;
    }
    const firstFailed = r.find((x) => !x.ok);
    const detail =
      firstFailed?.error ??
      `privileged worker returned ${r.length} results, expected ${opCount}`;
    this.close();
    caller.reject(new Error(detail));
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
    this.closeServer();
    this.ipcSocket?.destroy();
    this.ipcSocket = undefined;
    this.removeSocketFile();
    if (this.proc) terminateWorker(this.proc);
    if (this.tmpDir) {
      cleanupWorkerDir(this.tmpDir);
      this.tmpDir = undefined;
    }
  }

  private closeServer(): void {
    if (!this.server) return;
    try {
      this.server.close();
    } catch {
      // server.close() throws ERR_SERVER_NOT_RUNNING if already closed
      // (e.g. called after the connection handler already stopped it)
    }
    this.server = undefined;
  }

  private removeSocketFile(): void {
    if (!this.ipcSocketPath) return;
    try {
      fs.unlinkSync(this.ipcSocketPath);
    } catch {
      // best-effort; already removed by tmpDir cleanup or never created
    }
    this.ipcSocketPath = undefined;
  }
}

// Result list for a response whose length differs from the op count when
// continueOnError is set.
function partialResults(r: WorkerResult[], opCount: number): WorkerResult[] {
  // Crash-after-completion sentinel: the worker appends exactly one
  // extra {ok:false} entry via emitErrorAndExit AFTER all N ops
  // completed. Preserve the N+1 array so callers can detect it via
  // results.length > ops.length — slicing it away would leave them
  // with a complete-looking result set that silently followed a
  // non-zero worker exit (the bug reported against sudoAtomicRead).
  if (r.length === opCount + 1 && crashSentinel(r, opCount)) {
    return [...r]; // N+1 array; sentinel at index ops.length
  }
  // General: worker crashed mid-batch — clamp to ops.length and pad
  // unprocessed tail ops so callers always receive exactly ops.length
  // results and can distinguish completed ops from those that never ran.
  //
  // Do NOT close the session here: the caller (e.g. sudoAtomicWrite)
  // may have a subsequent exec() call (e.g. chmod ops after write ops)
  // that must be able to detect the session state via its own error
  // rather than an abrupt "session is closed" from a preemptive close.
  // The worker exiting will close the socket naturally, causing the
  // readline 'close' event to fire and reject any pending exec().
  return padResults(r, opCount);
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
