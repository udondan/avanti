/** Incoming IPC connections of a privileged worker session: nonce handshake and framing. */
import * as crypto from 'crypto';
import type * as net from 'net';
import * as readline from 'readline';

// The session side of a connection: what the handshake and the response
// stream need to know about and do to the owning SudoWorkerSession.
export interface IpcHost {
  readonly nonce: string;
  // true once a connection has completed the nonce handshake.
  hasChannel(): boolean;
  isChannel(socket: net.Socket): boolean;
  // Promotes a verified socket to the active IPC channel.
  promote(socket: net.Socket, rl: readline.Interface): void;
  // Closes the session and rejects the in-flight exec() (if any) with err.
  abort(err: Error): void;
  handleResponse(line: string): void;
}

const AUTH_TIMEOUT_MS = 5000;

// Guard against OOM: readline buffers each newline-delimited response
// entirely in memory before emitting 'line'. Cap the in-flight bytes at
// 500 MiB (the runPrivilegedWorker one-shot path caps maxBuffer at
// 150 MiB for comparison). Track raw socket bytes; reset after each
// complete line so the cap applies per-response, not per-session.
const MAX_RESPONSE_BYTES = 500 * 1024 * 1024;

interface Connection {
  readonly socket: net.Socket;
  readonly rl: readline.Interface;
  readonly authTimeout: NodeJS.Timeout;
  readonly host: IpcHost;
  // The first line from the worker must be the nonce that was passed via
  // --nonce= on the command line. This verifies the connecting process is
  // the worker we spawned (not a rogue process that won the race to connect
  // to the named-user sudo socket before the worker did).
  nonceVerified: boolean;
}

// Use server.on (not server.once) so a rogue process that connects before
// the worker cannot take the single slot, close the server, and prevent the
// real worker from connecting. ipcSocket is only assigned after the nonce
// handshake succeeds; any connection that fails the nonce check is destroyed
// and the server keeps listening. Once the real worker connects and verifies
// its nonce, subsequent connections are rejected immediately.
export function acceptConnection(socket: net.Socket, host: IpcHost): void {
  if (host.hasChannel()) {
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
  }, AUTH_TIMEOUT_MS);
  authTimeout.unref();
  socket.once('close', () => clearTimeout(authTimeout));

  socket.on('error', (err) => {
    clearTimeout(authTimeout);
    if (host.isChannel(socket)) {
      host.abort(err);
    } else {
      // Pre-nonce socket errored; just destroy it.
      socket.destroy();
    }
  });

  const counter = { pendingResponseBytes: 0 };
  socket.on('data', (chunk: Buffer) => {
    counter.pendingResponseBytes += chunk.length;
    if (counter.pendingResponseBytes > MAX_RESPONSE_BYTES) {
      host.abort(
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
  const conn: Connection = {
    socket,
    rl,
    authTimeout,
    host,
    nonceVerified: false,
  };
  rl.on('line', (line: string) => {
    counter.pendingResponseBytes = 0;
    onLine(conn, line.trim());
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
    if (!conn.nonceVerified || !host.isChannel(socket)) return;
    host.abort(
      new Error('SudoWorkerSession: IPC stream closed without a response'),
    );
  });
}

function onLine(conn: Connection, trimmed: string): void {
  if (!trimmed) {
    // Blank line before nonce verification: rogue connection probing for
    // FD exhaustion. Disconnect immediately rather than waiting for authTimeout.
    if (!conn.nonceVerified) drop(conn);
    return;
  }
  if (conn.nonceVerified) {
    conn.host.handleResponse(trimmed);
    return;
  }
  if (!nonceMatches(trimmed, conn.host.nonce)) {
    drop(conn);
    return;
  }
  conn.nonceVerified = true;
  // Nonce verified — promote this socket to the active IPC channel.
  clearTimeout(conn.authTimeout);
  conn.host.promote(conn.socket, conn.rl);
}

function nonceMatches(line: string, nonce: string): boolean {
  const lineBuf = Buffer.from(line);
  const nonceBuf = Buffer.from(nonce);
  return (
    lineBuf.length === nonceBuf.length &&
    crypto.timingSafeEqual(lineBuf, nonceBuf)
  );
}

function drop(conn: Connection): void {
  clearTimeout(conn.authTimeout);
  conn.rl.close();
  conn.socket.destroy();
}
