import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  sudoAtomicDelete,
  sudoAtomicWrite,
  SudoWorkerSession,
  SudoWritePartialError,
  type SudoChmodTarget,
  type SudoWriteTarget,
} from '../src/writer';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => SpawnSyncReturns<Buffer>
>;

const isWindows = process.platform === 'win32';
const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;

type ExecFn = (ops: unknown[], continueOnError?: boolean) => Promise<unknown>;

function fakeSession(exec: ExecFn): SudoWorkerSession {
  return {
    exec: vi.fn(exec),
    close: vi.fn(),
    trustedUids: new Set([0, currentUid]),
    sudo: true as const,
  } as unknown as SudoWorkerSession;
}

function sessionsOf(
  s: SudoWorkerSession,
): Map<true | string, SudoWorkerSession> {
  return new Map<true | string, SudoWorkerSession>([[true, s]]);
}

const write = (p: string): SudoWriteTarget => ({
  targetPath: p,
  content: Buffer.from('x'),
  sudo: true,
});
const chmod = (p: string): SudoChmodTarget => ({
  targetPath: p,
  mode: '0644',
  sudo: true,
});

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  mockSpawnSync.mockReset();
  process.env.AVANTI_NODE_EXEC = process.execPath;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AVANTI_NODE_EXEC;
  vi.restoreAllMocks();
});

describe.skipIf(isWindows)('sudoAtomicWrite — chmod targets', () => {
  it('sends writes and chmods as separate session batches and counts applied chmods', async () => {
    const s = fakeSession((ops) =>
      Promise.resolve(
        (ops as Array<{ type: string }>).map((op, i) =>
          op.type === 'chmod' && i === 1
            ? { ok: true, skipped: true }
            : { ok: true },
        ),
      ),
    );
    const applied = await sudoAtomicWrite(
      [write('/etc/a.conf')],
      [chmod('/etc/b.conf'), chmod('/etc/c.conf')],
      sessionsOf(s),
    );
    expect(applied).toBe(1);
    const calls = (s.exec as unknown as MockInstance).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0][0] as Array<{ type: string }>)[0].type).toBe('write-mv');
    expect(calls[1][0]).toEqual([
      { type: 'chmod', targetPath: '/etc/b.conf', mode: '0644' },
      { type: 'chmod', targetPath: '/etc/c.conf', mode: '0644' },
    ]);
  });

  it('handles chmod-only batches', async () => {
    const s = fakeSession(() => Promise.resolve([{ ok: true }]));
    expect(
      await sudoAtomicWrite([], [chmod('/etc/only.conf')], sessionsOf(s)),
    ).toBe(1);
  });

  it('warns per file and continues when the chmod session exec throws', async () => {
    const s = fakeSession(() => Promise.reject(new Error('socket closed')));
    const applied = await sudoAtomicWrite(
      [],
      [chmod('/etc/a.conf'), chmod('/etc/b.conf')],
      sessionsOf(s),
    );
    expect(applied).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain(
      'could not apply chmod to /etc/a.conf: socket closed',
    );
  });

  it('stringifies non-Error rejections from the chmod session', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const s = fakeSession(() => Promise.reject('boom'));
    await sudoAtomicWrite([], [chmod('/etc/a.conf')], sessionsOf(s));
    expect(String(warn.mock.calls[0][0])).toContain(': boom.');
  });

  it('warns on per-op chmod failures and stops at missing results', async () => {
    const s = fakeSession(() =>
      Promise.resolve([{ ok: false, error: 'EPERM' }, { ok: false }]),
    );
    const applied = await sudoAtomicWrite(
      [],
      [chmod('/etc/a.conf'), chmod('/etc/b.conf'), chmod('/etc/c.conf')],
      sessionsOf(s),
    );
    expect(applied).toBe(0);
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs).toEqual([
      'Warning: chmod failed for /etc/a.conf: EPERM',
      'Warning: chmod failed for /etc/b.conf: unknown error',
    ]);
  });

  it('warns about a crash sentinel after all chmods succeeded', async () => {
    const s = fakeSession(() =>
      Promise.resolve([{ ok: true }, { ok: false, error: 'exit 1' }]),
    );
    expect(
      await sudoAtomicWrite([], [chmod('/etc/a.conf')], sessionsOf(s)),
    ).toBe(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'privileged chmod worker crashed after completing all ops: exit 1',
    );
  });

  it('labels a sentinel without an error as unknown', async () => {
    const s = fakeSession(() => Promise.resolve([{ ok: true }, { ok: false }]));
    await sudoAtomicWrite([], [chmod('/etc/a.conf')], sessionsOf(s));
    expect(String(warn.mock.calls[0][0])).toContain(
      'crashed after completing all ops: unknown',
    );
  });

  it('ignores a successful extra result after the chmod ops', async () => {
    const s = fakeSession(() => Promise.resolve([{ ok: true }, { ok: true }]));
    await sudoAtomicWrite([], [chmod('/etc/a.conf')], sessionsOf(s));
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses a one-shot worker for chmods when no sessions are given', async () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'sudo') {
        const body = JSON.stringify({ results: [{ ok: true }] });
        return {
          pid: 1,
          output: [null, Buffer.from(body), null],
          stdout: Buffer.from(body),
          stderr: Buffer.from(''),
          status: 0,
          signal: null,
          error: undefined,
        };
      }
      return {
        pid: 1,
        output: [null, Buffer.from('0'), null],
        stdout: Buffer.from('0'),
        stderr: Buffer.from(''),
        status: 0,
        signal: null,
        error: undefined,
      };
    });
    expect(await sudoAtomicWrite([], [chmod('/etc/a.conf')])).toBe(1);
    expect(mockSpawnSync.mock.calls.some(([cmd]) => cmd === 'sudo')).toBe(true);
  });
});

describe.skipIf(isWindows)('sudoAtomicWrite — session errors', () => {
  it('throws when the sessions map lacks the identity', async () => {
    const s = fakeSession(() => Promise.resolve([]));
    const sessions = new Map<true | string, SudoWorkerSession>([['other', s]]);
    await expect(
      sudoAtomicWrite([write('/etc/a.conf')], [], sessions),
    ).rejects.toThrow('no privileged session for sudo identity "true"');
  });

  it('wraps a write session exec failure in SudoWritePartialError', async () => {
    const s = fakeSession(() => Promise.reject(new Error('worker killed')));
    const err = await sudoAtomicWrite(
      [write('/etc/a.conf')],
      [],
      sessionsOf(s),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SudoWritePartialError);
    expect((err as SudoWritePartialError).message).toBe('worker killed');
    expect((err as SudoWritePartialError).writtenPaths).toEqual([]);
  });

  it('stringifies non-Error write session rejections', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const s = fakeSession(() => Promise.reject('gone'));
    const err = await sudoAtomicWrite(
      [write('/etc/a.conf')],
      [],
      sessionsOf(s),
    ).catch((e: unknown) => e);
    expect((err as SudoWritePartialError).message).toBe('gone');
  });

  it('uses a generic message for a failed op without an error', async () => {
    const s = fakeSession(() => Promise.resolve([{ ok: false }]));
    const err = await sudoAtomicWrite(
      [write('/etc/a.conf')],
      [],
      sessionsOf(s),
    ).catch((e: unknown) => e);
    expect((err as SudoWritePartialError).message).toBe(
      'privileged worker op failed',
    );
  });
});

describe.skipIf(isWindows)('sudoAtomicDelete — session errors', () => {
  it('throws when the sessions map lacks the identity', async () => {
    const s = fakeSession(() => Promise.resolve([]));
    const sessions = new Map<true | string, SudoWorkerSession>([['other', s]]);
    await expect(
      sudoAtomicDelete([['/etc/a.conf', true]], false, sessions),
    ).rejects.toThrow('no privileged session for sudo identity "true"');
  });

  it('warns instead of throwing in bestEffort mode', async () => {
    const s = fakeSession(() => Promise.resolve([]));
    const sessions = new Map<true | string, SudoWorkerSession>([['other', s]]);
    const done = await sudoAtomicDelete(
      [['/etc/a.conf', true]],
      true,
      sessions,
    );
    expect(done.size).toBe(0);
    expect(String(warn.mock.calls[0][0])).toContain(
      'privileged deletion worker failed',
    );
  });

  it('deletes through the session', async () => {
    const s = fakeSession(() => Promise.resolve([{ ok: true }]));
    const done = await sudoAtomicDelete(
      [['/etc/a.conf', true]],
      false,
      sessionsOf(s),
    );
    expect([...done]).toEqual(['/etc/a.conf']);
  });
});
