import { EventEmitter } from 'events';
import type * as net from 'net';
import { PassThrough } from 'stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Unit-level error paths of the helpers behind SudoWorkerSession: the IPC
// handshake, the sudo process helpers and the readiness gate.

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    constants: { ...actual.constants },
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { acceptConnection, type IpcHost } from '../src/writer/session-ipc';
import { createReadyGate } from '../src/writer/session-ready';
import {
  spawnSessionWorker,
  terminateWorker,
  workerExitPendingMessage,
  workerExitReadyMessage,
} from '../src/writer/session-worker';

const mockSpawn = spawn as unknown as MockInstance;
const mockOpen = fs.openSync as unknown as MockInstance;
const mockClose = fs.closeSync as unknown as MockInstance;

const NONCE = 'a'.repeat(64);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockSpawn.mockReset();
  mockOpen.mockClear();
  mockClose.mockClear();
});

// A stream standing in for an accepted IPC socket.
function fakeSocket(): { socket: net.Socket; destroy: MockInstance } {
  const stream = new PassThrough();
  const destroy = vi.spyOn(stream, 'destroy');
  return { socket: stream as unknown as net.Socket, destroy };
}

interface FakeHost extends IpcHost {
  channel: net.Socket | undefined;
  abort: ReturnType<typeof vi.fn<(err: Error) => void>>;
  handleResponse: ReturnType<typeof vi.fn<(line: string) => void>>;
  promote: ReturnType<typeof vi.fn<IpcHost['promote']>>;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    nonce: NONCE,
    channel: undefined,
    hasChannel: () => host.channel !== undefined,
    isChannel: (socket) => host.channel === socket,
    promote: vi.fn((socket: net.Socket) => {
      host.channel = socket;
    }),
    abort: vi.fn(),
    handleResponse: vi.fn(),
  };
  return host;
}

// Lets readline process the data written to a fake socket.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('acceptConnection', () => {
  let host: FakeHost;
  beforeEach(() => {
    host = fakeHost();
  });

  it('drops connections that arrive after the channel is established', () => {
    host.channel = fakeSocket().socket;
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('data')).toBe(0);
  });

  it('destroys a connection that does not authenticate within 5s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    vi.advanceTimersByTime(4_999);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroy).toHaveBeenCalled();
    expect(host.promote).not.toHaveBeenCalled();
  });

  it('destroys a pre-handshake connection on a socket error', () => {
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    // readline forwards input errors to its interface, which has no 'error'
    // listener, so the emit rethrows after the session's handler ran.
    expect(() => socket.emit('error', new Error('ECONNRESET'))).toThrow(
      'ECONNRESET',
    );
    expect(destroy).toHaveBeenCalled();
    expect(host.abort).not.toHaveBeenCalled();
  });

  it('aborts the session on an error of the verified channel', async () => {
    const { socket } = fakeSocket();
    acceptConnection(socket, host);
    socket.write(NONCE + '\n');
    await flush();
    expect(host.promote).toHaveBeenCalledTimes(1);
    const err = new Error('ECONNRESET');
    // See above: readline rethrows the input error after the handler ran.
    expect(() => socket.emit('error', err)).toThrow('ECONNRESET');
    expect(host.abort).toHaveBeenCalledWith(err);
  });

  it('aborts when a response exceeds 500 MiB', () => {
    const { socket } = fakeSocket();
    acceptConnection(socket, host);
    // Call the byte counter directly with an oversized chunk rather than
    // pushing 500 MiB through the stream.
    const [counter] = socket.listeners('data') as Array<
      (chunk: { length: number }) => void
    >;
    counter({ length: 300 * 1024 * 1024 });
    expect(host.abort).not.toHaveBeenCalled();
    counter({ length: 300 * 1024 * 1024 });
    expect(host.abort).toHaveBeenCalledTimes(1);
    expect(host.abort.mock.calls[0][0].message).toContain(
      'IPC response exceeded 500 MiB limit',
    );
  });

  it('drops a connection that sends a blank line before the nonce', async () => {
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    socket.write('\n');
    await flush();
    expect(destroy).toHaveBeenCalled();
    expect(host.promote).not.toHaveBeenCalled();
    expect(host.abort).not.toHaveBeenCalled();
  });

  it('drops a connection that sends the wrong nonce', async () => {
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    socket.write('b'.repeat(64) + '\n');
    await flush();
    expect(destroy).toHaveBeenCalled();
    expect(host.promote).not.toHaveBeenCalled();
  });

  it('drops a connection whose nonce has the wrong length', async () => {
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    socket.write('short\n');
    await flush();
    expect(destroy).toHaveBeenCalled();
    expect(host.promote).not.toHaveBeenCalled();
  });

  it('ignores blank lines after the handshake and forwards responses', async () => {
    const { socket, destroy } = fakeSocket();
    acceptConnection(socket, host);
    socket.write(NONCE + '\n\n{"results":[]}\n');
    await flush();
    expect(host.promote).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(host.handleResponse).toHaveBeenCalledExactlyOnceWith(
      '{"results":[]}',
    );
  });

  it('aborts when the verified channel closes without a response', async () => {
    const { socket } = fakeSocket();
    acceptConnection(socket, host);
    socket.write(NONCE + '\n');
    await flush();
    socket.end();
    await flush();
    expect(host.abort).toHaveBeenCalledTimes(1);
    expect(host.abort.mock.calls[0][0].message).toBe(
      'SudoWorkerSession: IPC stream closed without a response',
    );
  });
});

describe('spawnSessionWorker', () => {
  const spec = {
    sudo: true as const,
    nodeExec: '/usr/bin/node',
    workerPath: '/opt/worker.js',
    socketPath: '/tmp/x.sock',
    nonce: NONCE,
  };

  it('passes the controlling TTY to sudo and closes it afterwards', () => {
    const proc = new EventEmitter();
    mockSpawn.mockReturnValue(proc);
    mockOpen.mockReturnValueOnce(99);
    mockClose.mockImplementationOnce(() => undefined);
    expect(spawnSessionWorker(spec)).toBe(proc);
    expect(mockOpen).toHaveBeenCalledWith('/dev/tty', 'r+');
    const opts = mockSpawn.mock.calls[0][2] as {
      stdio: unknown[];
      env: NodeJS.ProcessEnv;
    };
    expect(opts.stdio[0]).toBe(99);
    expect(opts.env.AVANTI_WORKER_NONCE).toBe(NONCE);
    expect(mockClose).toHaveBeenCalledWith(99);
  });

  it('ignores a failure to close the TTY', () => {
    const proc = new EventEmitter();
    mockSpawn.mockReturnValue(proc);
    mockOpen.mockReturnValueOnce(98);
    mockClose.mockImplementationOnce(() => {
      throw new Error('EBADF');
    });
    expect(spawnSessionWorker(spec)).toBe(proc);
    expect(mockClose).toHaveBeenCalledWith(98);
  });

  it('closes the TTY even when spawn throws', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn sudo ENOENT');
    });
    mockOpen.mockReturnValueOnce(97);
    mockClose.mockImplementationOnce(() => undefined);
    expect(() => spawnSessionWorker(spec)).toThrow('spawn sudo ENOENT');
    expect(mockClose).toHaveBeenCalledWith(97);
  });
});

describe('worker exit messages', () => {
  it.each([
    [false, 1, null, 'privileged worker failed before connecting (exit 1)'],
    [true, 2, null, 'privileged worker crashed after connecting (exit 2)'],
    [
      false,
      null,
      'SIGTERM',
      'privileged worker killed before connecting (signal SIGTERM)',
    ],
    [
      true,
      null,
      null,
      'privileged worker killed after connecting (signal unknown)',
    ],
  ] as const)(
    'readiness message (connected=%s, code=%s, signal=%s)',
    (connected, code, signal, expected) => {
      expect(workerExitReadyMessage(connected, code, signal)).toBe(expected);
    },
  );

  it.each([
    [0, null, 'privileged worker exited unexpectedly with no response'],
    [5, null, 'privileged worker failed (exit 5)'],
    [null, 'SIGKILL', 'privileged worker killed (signal SIGKILL)'],
    [null, null, 'privileged worker killed (signal unknown)'],
  ] as const)(
    'pending message (code=%s, signal=%s)',
    (code, signal, expected) => {
      expect(workerExitPendingMessage(code, signal)).toBe(expected);
    },
  );
});

describe('terminateWorker', () => {
  class FakeProc extends EventEmitter {
    constructor(readonly pid: number | undefined) {
      super();
    }
    kill = vi.fn();
  }
  const asChild = (p: FakeProc): ChildProcess => p as unknown as ChildProcess;

  it('does nothing for a process without a pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = new FakeProc(undefined);
    terminateWorker(asChild(proc));
    expect(kill).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to a direct kill and escalates to SIGKILL after 5s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const proc = new FakeProc(4321);
    terminateWorker(asChild(proc));
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    // The SIGKILL escalation swallows ESRCH as well.
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(kill).toHaveBeenLastCalledWith(-4321, 'SIGKILL');
  });

  it('cancels the SIGKILL escalation once the process closes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = new FakeProc(4321);
    terminateWorker(asChild(proc));
    expect(proc.kill).not.toHaveBeenCalled();
    proc.emit('close', 0, null);
    vi.advanceTimersByTime(5_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4321, 'SIGTERM');
  });
});

describe('createReadyGate', () => {
  it('runs onTimeout and rejects when nothing settles it in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onTimeout = vi.fn<() => void>();
    const gate = createReadyGate<string>(1_000, 'worker never connected', () =>
      onTimeout(),
    );
    const rejection = expect(gate.promise).rejects.toThrow(
      'worker never connected',
    );
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await rejection;
  });

  it('does not time out once resolved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onTimeout = vi.fn<() => void>();
    const gate = createReadyGate<string>(1_000, 'late', () => onTimeout());
    gate.resolve('ok');
    vi.advanceTimersByTime(1_000);
    await expect(gate.promise).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
