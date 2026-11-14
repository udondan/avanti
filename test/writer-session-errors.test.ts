import { EventEmitter } from 'events';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { WorkerRequest, WorkerResult } from '../src/privileged-worker';

// Error paths of SudoWorkerSession, driven against its real Unix-socket IPC
// server. Only the sudo process is faked: `spawn` returns an EventEmitter that
// stands in for sudo, and the test itself plays the worker by connecting to
// the socket path the session passed on the command line.

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    constants: { ...actual.constants },
    chmodSync: vi.fn(actual.chmodSync),
    mkdtempSync: vi.fn(actual.mkdtempSync),
  };
});

// The session stages the compiled worker from dist/; the fake sudo never runs
// it, so skip the staging and hand out fixed paths.
vi.mock('../src/writer/worker-staging', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/writer/worker-staging')>();
  return {
    ...actual,
    prepareWorkerExec: vi.fn(() => ({
      nodeExec: process.execPath,
      resolvedWorkerPath: '/fake/privileged-worker.js',
    })),
  };
});

import * as fs from 'fs';
import { spawn } from 'child_process';
import {
  openPrivilegedSessions,
  SudoWorkerSession,
} from '../src/writer/sudo-session';
import { activeSudoSessions } from '../src/writer/registry';

const mockSpawn = spawn as unknown as MockInstance;
const mockChmod = fs.chmodSync as unknown as MockInstance;
const mockMkdtemp = fs.mkdtempSync as unknown as MockInstance;

const isWindows = process.platform === 'win32';
const originalPlatform = process.platform;

const ops = (n: number): WorkerRequest['ops'] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'delete' as const,
    targetPath: `/etc/avanti-test-${i}`,
  }));

// Stands in for the detached sudo process.
class FakeSudo extends EventEmitter {
  pid: number | undefined = undefined;
  unref = vi.fn();
  kill = vi.fn();
}

interface SpawnedWorker {
  proc: FakeSudo;
  args: string[];
  socketPath: string;
  nonce: string;
}

let spawned: SpawnedWorker[];
let clients: net.Socket[];
let sessions: SudoWorkerSession[];
let killSpy: MockInstance;

function newSession(sudo: true | string = true): SudoWorkerSession {
  const s = new SudoWorkerSession(sudo);
  sessions.push(s);
  return s;
}

beforeEach(() => {
  spawned = [];
  clients = [];
  sessions = [];
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(
    (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const proc = new FakeSudo();
      const socketArg = args.find((a) => a.startsWith('--socket-path='));
      spawned.push({
        proc,
        args,
        socketPath: socketArg?.slice('--socket-path='.length) ?? '',
        nonce: opts.env.AVANTI_WORKER_NONCE ?? '',
      });
      return proc;
    },
  );
  // Never signal real process groups from these tests.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  for (const s of sessions) s.close();
  for (const c of clients) c.destroy();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockChmod.mockClear();
  mockMkdtemp.mockClear();
});

// Waits until the session has spawned its (fake) sudo process.
async function waitForSpawn(index = 0): Promise<SpawnedWorker> {
  await vi.waitFor(() => expect(spawned.length).toBeGreaterThan(index));
  return spawned[index];
}

// Plays the worker: connects to the session socket and sends the nonce.
// Returns the connected client and an async iterator over request lines.
async function connectWorker(
  w: SpawnedWorker,
  nonce = w.nonce,
): Promise<{ client: net.Socket; requests: () => Promise<WorkerRequest> }> {
  const client = net.createConnection(w.socketPath);
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  client.on('error', () => undefined);
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  readline.createInterface({ input: client }).on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  client.write(nonce + '\n');
  const requests = async (): Promise<WorkerRequest> => {
    const line =
      lines.shift() ??
      (await new Promise<string>((resolve) => waiting.push(resolve)));
    return JSON.parse(line) as WorkerRequest;
  };
  return { client, requests };
}

// Opens a session and completes the worker handshake.
async function connectedSession(): Promise<{
  session: SudoWorkerSession;
  worker: SpawnedWorker;
  client: net.Socket;
  requests: () => Promise<WorkerRequest>;
}> {
  const session = newSession();
  const worker = await waitForSpawn();
  const { client, requests } = await connectWorker(worker);
  // A no-op exec round trip proves the handshake completed.
  const first = session.exec(ops(1));
  await requests();
  client.write(JSON.stringify({ results: [{ ok: true }] }) + '\n');
  await expect(first).resolves.toEqual([{ ok: true }]);
  return { session, worker, client, requests };
}

function respond(client: net.Socket, results: WorkerResult[]): void {
  client.write(JSON.stringify({ results }) + '\n');
}

describe('SudoWorkerSession — platform guard', () => {
  it('refuses to construct on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => new SudoWorkerSession(true)).toThrow(
      'sudo is not supported on Windows',
    );
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('openPrivilegedSessions opens nothing on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(openPrivilegedSessions([true, 'alice']).size).toBe(0);
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });
});

describe.skipIf(isWindows)('SudoWorkerSession — setup failures', () => {
  it('opens the IPC dir to the target user for named-user sudo', async () => {
    const user = os.userInfo().username;
    const session = newSession(user);
    const worker = await waitForSpawn();
    const ipcDir = path.dirname(worker.socketPath);
    expect(mockChmod).toHaveBeenCalledWith(ipcDir, 0o711);
    expect(fs.statSync(ipcDir).mode & 0o777).toBe(0o711);
    expect(fs.statSync(worker.socketPath).mode & 0o777).toBe(0o666);
    expect(worker.args).toEqual(expect.arrayContaining(['-u', user]));
    session.close();
    expect(fs.existsSync(ipcDir)).toBe(false);
  });

  it('rejects exec() and deregisters the session when the server cannot listen', async () => {
    // A short path whose parent does not exist: listen() fails.
    mockMkdtemp.mockImplementationOnce(() =>
      path.join('/tmp', `avanti-missing-${process.pid}`, 'avanti-ipc-x'),
    );
    const session = newSession();
    expect(activeSudoSessions.has(session)).toBe(true);
    // ENOENT, or EACCES under a sandbox that guards /tmp.
    await expect(session.exec(ops(1))).rejects.toMatchObject({
      syscall: 'listen',
    });
    expect(activeSudoSessions.has(session)).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    await expect(session.exec(ops(1))).rejects.toThrow(
      'SudoWorkerSession: session is closed',
    );
  });

  it('aborts without spawning sudo when the socket cannot be chmodded', async () => {
    mockChmod.mockImplementationOnce(() => {
      throw new Error('EPERM: chmod denied');
    });
    const session = newSession();
    await expect(session.exec(ops(1))).rejects.toThrow('EPERM: chmod denied');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects exec() when spawning sudo throws', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn sudo ENOENT');
    });
    const session = newSession();
    await expect(session.exec(ops(1))).rejects.toThrow('spawn sudo ENOENT');
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects exec() on a sudo spawn error without signalling the process', async () => {
    const session = newSession();
    const worker = await waitForSpawn();
    worker.proc.pid = 4242;
    const pending = session.exec(ops(1));
    worker.proc.emit('error', new Error('spawn EACCES'));
    await expect(pending).rejects.toThrow('spawn EACCES');
    expect(killSpy).not.toHaveBeenCalled();
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects exec() when sudo exits before the worker connects', async () => {
    const session = newSession();
    const worker = await waitForSpawn();
    const pending = session.exec(ops(1));
    worker.proc.emit('close', 1, null);
    await expect(pending).rejects.toThrow(
      'privileged worker failed before connecting (exit 1)',
    );
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('reports the signal when sudo is killed before the worker connects', async () => {
    const session = newSession();
    const worker = await waitForSpawn();
    const pending = session.exec(ops(1));
    worker.proc.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow(
      'privileged worker killed before connecting (signal SIGKILL)',
    );
  });

  it('closes every already opened session when a later one fails', () => {
    const before = activeSudoSessions.size;
    const actual = mockMkdtemp.getMockImplementation();
    if (!actual) throw new Error('mkdtempSync mock has no implementation');
    mockMkdtemp.mockImplementationOnce(actual).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(() => openPrivilegedSessions([true, 'nobody'])).toThrow('ENOSPC');
    expect(activeSudoSessions.size).toBe(before);
  });
});

describe.skipIf(isWindows)('SudoWorkerSession — worker exit', () => {
  it('rejects an in-flight exec() when the worker exits without answering', async () => {
    const { session, worker, requests } = await connectedSession();
    const pending = session.exec(ops(1));
    await requests();
    worker.proc.emit('close', 0, null);
    await expect(pending).rejects.toThrow(
      'privileged worker exited unexpectedly with no response',
    );
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('reports the exit code of a worker that crashes mid-request', async () => {
    const { session, worker, requests } = await connectedSession();
    const pending = session.exec(ops(1));
    await requests();
    worker.proc.emit('close', 3, null);
    await expect(pending).rejects.toThrow('privileged worker failed (exit 3)');
  });

  it('closes an idle session when the worker exits', async () => {
    const { session, worker } = await connectedSession();
    worker.proc.emit('close', 0, null);
    await vi.waitFor(() => expect(activeSudoSessions.has(session)).toBe(false));
    await expect(session.exec(ops(1))).rejects.toThrow(
      'SudoWorkerSession: session is closed',
    );
  });

  it('closes the session when an exec() starts right as the worker exits', async () => {
    const { session, worker } = await connectedSession();
    // The exit is handled one tick later; the exec() issued in between is a
    // different pending request than the (empty) one seen at exit time.
    worker.proc.emit('close', 0, null);
    await expect(session.exec(ops(1))).rejects.toThrow(
      'SudoWorkerSession: session closed',
    );
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('leaves an exit seen after an explicit close() alone', async () => {
    const { session, worker, requests } = await connectedSession();
    const pending = session.exec(ops(1));
    await requests();
    worker.proc.emit('close', 0, null);
    session.close();
    // close() wins: the in-flight exec() gets the generic close error, not the
    // worker-exit message.
    await expect(pending).rejects.toThrow('SudoWorkerSession: session closed');
  });

  it('rejects a concurrent exec()', async () => {
    const { session, client, requests } = await connectedSession();
    const first = session.exec(ops(1));
    await requests();
    await expect(session.exec(ops(1))).rejects.toThrow(
      'SudoWorkerSession: concurrent exec() calls are not supported',
    );
    respond(client, [{ ok: true }]);
    await expect(first).resolves.toEqual([{ ok: true }]);
  });
});

describe.skipIf(isWindows)('SudoWorkerSession — connection timeout', () => {
  it('does not spawn sudo when closed before the server is listening', async () => {
    const session = newSession();
    session.close();
    // Give the pending listen() a chance to complete.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects exec() when the worker does not connect within 30s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = newSession();
    await waitForSpawn();
    const rejection = expect(session.exec(ops(1))).rejects.toThrow(
      'SudoWorkerSession: privileged worker failed to connect within 30s',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(activeSudoSessions.has(session)).toBe(false);
  });
});

describe.skipIf(isWindows)('SudoWorkerSession — responses', () => {
  it('rejects exec() on a response without a results array', async () => {
    const { session, client, requests } = await connectedSession();
    const pending = session.exec(ops(1));
    await requests();
    client.write(JSON.stringify({ nope: true }) + '\n');
    await expect(pending).rejects.toThrow(
      'failed to parse worker response: malformed response: missing results array',
    );
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('warns about a stray line with no request in flight and keeps the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { session, client, requests } = await connectedSession();
    client.write('not json\n');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain(
      'unexpected line from privileged worker (no op in flight)',
    );
    const pending = session.exec(ops(1));
    await requests();
    respond(client, [{ ok: true }]);
    await expect(pending).resolves.toEqual([{ ok: true }]);
  });

  it('pads a short continueOnError response', async () => {
    const { session, client, requests } = await connectedSession();
    const pending = session.exec(ops(3), true);
    expect((await requests()).continueOnError).toBe(true);
    respond(client, [{ ok: true }]);
    const results = await pending;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true });
    expect(results[2]).toEqual({
      ok: false,
      error: 'worker exited before processing this op',
    });
    expect(activeSudoSessions.has(session)).toBe(true);
  });

  it('keeps the crash sentinel of a continueOnError response', async () => {
    const { session, client, requests } = await connectedSession();
    const pending = session.exec(ops(1), true);
    await requests();
    respond(client, [{ ok: true }, { ok: false, error: 'worker crashed' }]);
    await expect(pending).resolves.toEqual([
      { ok: true },
      { ok: false, error: 'worker crashed' },
    ]);
  });

  it('rejects a short strict response with the first failed op error', async () => {
    const { session, client, requests } = await connectedSession();
    const pending = session.exec(ops(2));
    await requests();
    respond(client, [{ ok: false, error: 'EACCES: permission denied' }]);
    await expect(pending).rejects.toThrow('EACCES: permission denied');
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects a short strict response without failures with a count mismatch', async () => {
    const { session, client, requests } = await connectedSession();
    const pending = session.exec(ops(2));
    await requests();
    respond(client, [{ ok: true }]);
    await expect(pending).rejects.toThrow(
      'privileged worker returned 1 results, expected 2',
    );
  });
});

describe.skipIf(isWindows)('SudoWorkerSession — request delivery', () => {
  it('times out an exec() that never gets a response', async () => {
    const { session, requests } = await connectedSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = session.exec(ops(1), false, 1_000);
    const rejection = expect(pending).rejects.toThrow(
      'SudoWorkerSession: exec() timed out',
    );
    await requests();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects exec() when the request write reports an error', async () => {
    const { session } = await connectedSession();
    vi.spyOn(net.Socket.prototype, 'write').mockImplementationOnce(
      (_chunk: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          (cb as (err?: Error | null) => void)(new Error('write EPIPE'));
        }
        return false;
      },
    );
    await expect(session.exec(ops(1))).rejects.toThrow('write EPIPE');
    expect(activeSudoSessions.has(session)).toBe(false);
  });

  it('rejects exec() when the request write throws', async () => {
    const { session } = await connectedSession();
    vi.spyOn(net.Socket.prototype, 'write').mockImplementationOnce(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    await expect(session.exec(ops(1))).rejects.toThrow('ERR_STREAM_DESTROYED');
    expect(activeSudoSessions.has(session)).toBe(false);
  });
});
