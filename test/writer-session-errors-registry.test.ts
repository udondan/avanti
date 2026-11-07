import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// The process 'exit' / SIGINT / SIGTERM handlers of the writer registry. They
// are registered once per process; this file clears the registration flag and
// captures the handlers through a process.on spy instead of installing real
// ones, so they can be invoked without signalling the test process.

type Handler = (arg?: unknown) => void;
type Registry = typeof import('../src/writer/registry');

const HANDLERS_KEY = Symbol.for('avanti.writer.exitHandlersRegistered');
const procState = process as unknown as Record<symbol, unknown>;

let registry: Registry;
const handlers = new Map<string, Handler>();

beforeAll(async () => {
  delete procState[HANDLERS_KEY];
  const onSpy = vi
    .spyOn(process, 'on')
    .mockImplementation((event: string | symbol, fn: Handler) => {
      handlers.set(String(event), fn);
      return process;
    });
  try {
    vi.resetModules();
    registry = await import('../src/writer/registry');
  } finally {
    // The re-evaluated module set the flag again, so no further evaluation
    // in this process registers real handlers.
    onSpy.mockRestore();
  }
});

afterEach(() => {
  registry.activeSudoSessions.clear();
  vi.restoreAllMocks();
});

function getHandler(event: string): Handler {
  const h = handlers.get(event);
  if (!h) throw new Error(`no ${event} handler registered`);
  return h;
}

function mockExit(): MockInstance {
  return vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
}

describe('writer registry process handlers', () => {
  it('registers exit, SIGTERM and SIGINT handlers', () => {
    expect([...handlers.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'exit',
      'SIGINT',
      'SIGTERM',
    ]);
  });

  it('removes staged worker dirs on process exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-reg-test-'));
    registry.stagedWorkerDirs.add(dir);
    getHandler('exit')();
    expect(fs.existsSync(dir)).toBe(false);
    expect(registry.stagedWorkerDirs.has(dir)).toBe(false);
  });

  it('exits with 130 right away on SIGINT when no session is open', () => {
    const exit = mockExit();
    getHandler('SIGINT')('SIGINT');
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
  });

  it('closes open sessions on SIGTERM, then exits with 143 one tick later', async () => {
    const exit = mockExit();
    const failing = {
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    };
    const ok = { close: vi.fn() };
    registry.activeSudoSessions.add(failing);
    registry.activeSudoSessions.add(ok);
    getHandler('SIGTERM')('SIGTERM');
    // A session whose close() throws does not stop the others from closing.
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(ok.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });
});
