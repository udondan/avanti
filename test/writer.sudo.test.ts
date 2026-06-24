import * as fs from 'fs';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  sudoAtomicDelete,
  sudoAtomicWrite,
  sudoUserArgs,
  SudoWorkerSession,
  SudoWritePartialError,
  SudoWriteTarget,
} from '../src/writer';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawnSync, spawn, type SpawnSyncReturns } from 'child_process';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => SpawnSyncReturns<Buffer>
>;

const mockSpawn = spawn as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => ReturnType<typeof spawn>
>;

function okResult(stdout = ''): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [null, Buffer.from(stdout), null],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    status: 0,
    signal: null,
    error: undefined,
  };
}

function failResult(status = 1): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [null, Buffer.from(''), null],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    status,
    signal: null,
    error: undefined,
  };
}

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockSpawn.mockReset();
  // resolveNodeExec looks for a root-owned node binary in SAFE_DIRS for
  // named-user sudo. On developer machines (Apple Silicon, mise/nvm installs),
  // there may be no root-owned system node. Set AVANTI_NODE_EXEC so
  // resolveNodeExec returns early without scanning SAFE_DIRS, keeping the
  // mock-based tests self-contained and environment-independent.
  process.env.AVANTI_NODE_EXEC = process.execPath;
});

afterEach(() => {
  delete process.env.AVANTI_NODE_EXEC;
  vi.clearAllMocks();
});

describe('sudoUserArgs', () => {
  it('returns empty array for true (root)', () => {
    expect(sudoUserArgs(true)).toEqual([]);
  });

  it('returns -u <name> for a username string', () => {
    expect(sudoUserArgs('www-data')).toEqual(['-u', 'www-data']);
  });
});

const isWindows = process.platform === 'win32';

// runPrivilegedWorker now writes the JSON request to a temp file and passes
// its path as --req-file=<path> to the worker, keeping stdin as 'inherit' for
// macOS sudo credential-cache lookup. This helper mocks spawnSync to capture
// the req file content (which is synchronously readable during the mock
// callback, before the finally block deletes it) and returns it as parsed JSON.
function mockSpawnSyncCapturingReq(resultCount: number): {
  getReq: () => { ops: unknown[] };
} {
  let captured: string | undefined;
  mockSpawnSync.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === 'sudo') {
      const reqArg = (args as string[]).find((a) =>
        a.startsWith('--req-file='),
      );
      if (reqArg) {
        captured = fs.readFileSync(reqArg.slice('--req-file='.length), 'utf8');
      }
      return workerOkResult(resultCount);
    }
    return okResult('0'); // id -u calls from buildTrustedUids
  });
  return { getReq: () => JSON.parse(captured ?? 'null') as { ops: unknown[] } };
}

// Helper that produces a fake privileged-worker success response.
function workerOkResult(opCount = 1): SpawnSyncReturns<Buffer> {
  const results = Array.from({ length: opCount }, () => ({ ok: true }));
  const body = JSON.stringify({ results });
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

describe.skipIf(isWindows)('sudoAtomicWrite', () => {
  it('returns immediately and makes no spawnSync calls for empty targets', async () => {
    await sudoAtomicWrite([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('makes exactly one sudo call for multiple write-mv files with the same identity', async () => {
    mockSpawnSync.mockReturnValue(workerOkResult(3));

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      { targetPath: '/etc/b.conf', content: Buffer.from('b'), sudo: true },
      { targetPath: '/etc/c.conf', content: Buffer.from('c'), sudo: true },
    ];
    await sudoAtomicWrite(targets);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    expect(sudoCalls[0][1]).toEqual(
      expect.arrayContaining([
        process.execPath,
        expect.stringContaining('privileged-worker.js'),
      ]),
    );
    expect(sudoCalls[0][2]).toMatchObject({
      stdio: ['inherit', 'pipe', 'inherit'],
    });
  });

  it('encodes all ops in a single JSON input for the worker', async () => {
    const { getReq } = mockSpawnSyncCapturingReq(2);

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      {
        targetPath: '/etc/b.conf',
        content: Buffer.from('b'),
        sudo: true,
        writeInPlace: true,
      },
    ];
    await sudoAtomicWrite(targets);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    const { ops } = getReq() as {
      ops: Array<{ type: string; targetPath: string }>;
    };
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      type: 'write-mv',
      targetPath: '/etc/a.conf',
    });
    expect(ops[1]).toMatchObject({
      type: 'write-in-place',
      targetPath: '/etc/b.conf',
    });
  });

  it('encodes write-symlink ops without a contentSrc temp file', async () => {
    const { getReq } = mockSpawnSyncCapturingReq(1);

    const target: SudoWriteTarget = {
      targetPath: '/etc/link',
      content: Buffer.from('/etc/hosts'),
      symlinkTarget: '/etc/hosts',
      sudo: true,
    };
    await sudoAtomicWrite([target]);

    const { ops } = getReq() as {
      ops: Array<{ type: string; symlinkTarget?: string }>;
    };
    expect(ops[0].type).toBe('write-symlink');
    expect(ops[0].symlinkTarget).toBe('/etc/hosts');
    expect((ops[0] as Record<string, unknown>).contentB64).toBeUndefined();
  });

  it('makes separate worker calls for different sudo identities', async () => {
    mockSpawnSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'id') return okResult('999');
      return workerOkResult(1);
    });

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      {
        targetPath: '/etc/b.conf',
        content: Buffer.from('b'),
        sudo: 'www-data',
      },
    ];
    await sudoAtomicWrite(targets);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(2);
  });

  it('passes -u <name> args for named-user targets', async () => {
    mockSpawnSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'id') return okResult('999');
      return workerOkResult(1);
    });

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.txt',
      content: Buffer.from('hi'),
      sudo: 'nobody',
    };
    await sudoAtomicWrite([target]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    expect(sudoCalls[0][1]).toContain('-u');
    expect(sudoCalls[0][1]).toContain('nobody');
    expect(sudoCalls[0][2]).toMatchObject({
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  });

  it('throws when worker reports a failed op', async () => {
    const body = JSON.stringify({
      results: [{ ok: false, error: 'permission denied on /etc/test.conf' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(0),
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('data'),
      sudo: true,
    };
    await expect(sudoAtomicWrite([target])).rejects.toThrow(
      'permission denied',
    );
  });

  it('throws when worker exits with a non-zero status', async () => {
    mockSpawnSync.mockReturnValue(failResult(1));

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('data'),
      sudo: true,
    };
    await expect(sudoAtomicWrite([target])).rejects.toThrow(
      'privileged worker failed',
    );
  });

  it('passes a backupPath through to the op when specified', async () => {
    const { getReq } = mockSpawnSyncCapturingReq(1);

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('data'),
      sudo: true,
      backupPath: '/etc/test.conf.bak',
    };
    await sudoAtomicWrite([target]);

    const { ops } = getReq() as { ops: Array<{ backupPath?: string }> };
    expect(ops[0].backupPath).toBe('/etc/test.conf.bak');
  });

  it('throws SudoWritePartialError with writtenPaths for files before a mid-batch failure', async () => {
    const body = JSON.stringify({
      results: [{ ok: true }, { ok: true }, { ok: false, error: 'disk full' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(3),
      status: 1,
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      { targetPath: '/etc/b.conf', content: Buffer.from('b'), sudo: true },
      { targetPath: '/etc/c.conf', content: Buffer.from('c'), sudo: true },
    ];

    let caught: unknown;
    try {
      await sudoAtomicWrite(targets);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SudoWritePartialError);
    const err = caught as SudoWritePartialError;
    // Per-op failure message always leads; sentinel (from non-zero exit) is appended.
    expect(err.message).toContain('disk full');
    expect(err.writtenPaths).toEqual(['/etc/a.conf', '/etc/b.conf']);
  });

  it('throws SudoWritePartialError with empty writtenPaths when the first op fails', async () => {
    const body = JSON.stringify({
      results: [{ ok: false, error: 'permission denied' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(1),
      status: 1,
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    const target: SudoWriteTarget = {
      targetPath: '/etc/a.conf',
      content: Buffer.from('a'),
      sudo: true,
    };

    let caught: unknown;
    try {
      await sudoAtomicWrite([target]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SudoWritePartialError);
    const err = caught as SudoWritePartialError;
    expect(err.writtenPaths).toEqual([]);
  });

  it('throws SudoWritePartialError with all paths on crash-after-completion sentinel', async () => {
    // Worker completed all 2 ops but crashed before writeResponse — appends
    // a sentinel at index 2 (N+1) with ok:false.
    const body = JSON.stringify({
      results: [
        { ok: true },
        { ok: true },
        {
          ok: false,
          error:
            'privileged worker exited non-zero (1) after completing all ops',
        },
      ],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(2),
      status: 1,
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      { targetPath: '/etc/b.conf', content: Buffer.from('b'), sudo: true },
    ];

    let caught: unknown;
    try {
      await sudoAtomicWrite(targets);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SudoWritePartialError);
    const err = caught as SudoWritePartialError;
    // Both files landed on disk even though the worker crashed after them.
    expect(err.writtenPaths).toEqual(['/etc/a.conf', '/etc/b.conf']);
    expect(err.message).toContain('crashed after completing all write ops');
  });
});

describe.skipIf(isWindows)('sudoAtomicDelete', () => {
  it('returns immediately and makes no spawnSync calls for empty list', async () => {
    await sudoAtomicDelete([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('sends a delete op to the worker for a single path', async () => {
    const { getReq } = mockSpawnSyncCapturingReq(1);

    await sudoAtomicDelete([['/etc/stale.conf', true]]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    const { ops } = getReq() as {
      ops: Array<{ type: string; targetPath: string }>;
    };
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'delete',
      targetPath: '/etc/stale.conf',
    });
  });

  it('batches multiple deletions with the same identity into one worker call', async () => {
    const { getReq } = mockSpawnSyncCapturingReq(3);

    await sudoAtomicDelete([
      ['/etc/a.conf', true],
      ['/etc/b.conf', true],
      ['/etc/c.conf', true],
    ]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    const { ops } = getReq() as { ops: Array<{ type: string }> };
    expect(ops).toHaveLength(3);
    for (const op of ops) expect(op.type).toBe('delete');
  });

  it('makes separate worker calls for different sudo identities', async () => {
    mockSpawnSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'id') return okResult('33'); // www-data uid
      return workerOkResult(1);
    });

    await sudoAtomicDelete([
      ['/etc/a.conf', true],
      ['/etc/b.conf', 'www-data'],
    ]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(2);
  });

  it('throws when the worker reports a failed op (default strict mode)', async () => {
    const body = JSON.stringify({
      results: [{ ok: false, error: 'permission denied' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(0),
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    await expect(
      sudoAtomicDelete([['/etc/locked.conf', true]]),
    ).rejects.toThrow('permission denied');
  });

  it('warns (does not throw) when the worker reports a failed op in bestEffort mode', async () => {
    const body = JSON.stringify({
      results: [{ ok: false, error: 'permission denied' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(0),
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        sudoAtomicDelete([['/etc/locked.conf', true]], true),
      ).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('permission denied'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe.skipIf(isWindows)('SudoWorkerSession via sudoAtomicWrite', () => {
  it('uses session exec instead of spawnSync when a session is provided', async () => {
    // Verify that sudoAtomicWrite dispatches through session.exec() rather
    // than spawning a new sudo process when a pre-built session map is given.
    // Use a duck-typed mock session so the test does not depend on the session's
    // internal IPC mechanism (Unix socket, fd pipe, etc.).
    const execMock = vi.fn((ops: unknown[]) =>
      Promise.resolve(ops.map(() => ({ ok: true }))),
    );
    const fakeSession = {
      exec: execMock,
      close: vi.fn(),
      trustedUids: new Set([0]),
      sudo: true as const,
    } as unknown as SudoWorkerSession;

    const sessions = new Map<true | string, SudoWorkerSession>([
      [true, fakeSession],
    ]);

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('data'),
      sudo: true,
    };
    mockSpawnSync.mockReturnValue(workerOkResult(1));
    await sudoAtomicWrite([target], [], sessions);

    // spawnSync must NOT have been used for a privileged-worker invocation
    const workerSpawnSyncCalls = mockSpawnSync.mock.calls.filter(
      ([, args]) =>
        Array.isArray(args) &&
        (args as string[]).some((a) => a.includes('privileged-worker')),
    );
    expect(workerSpawnSyncCalls).toHaveLength(0);

    // session.exec() must have been called once with the expected op
    expect(execMock).toHaveBeenCalledTimes(1);
    const [ops] = execMock.mock.calls[0] as [Array<{ type: string }>];
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('write-mv');
  });

  it('throws SudoWritePartialError via session path when exec returns partial results', async () => {
    const currentUid =
      typeof process.getuid === 'function' ? process.getuid() : 0;
    const execMock = vi.fn(() =>
      Promise.resolve([
        { ok: true },
        { ok: true },
        { ok: false, error: 'disk full' },
      ]),
    );
    const fakeSession = {
      exec: execMock,
      close: vi.fn(),
      trustedUids: new Set([0, currentUid]),
      sudo: true as const,
    } as unknown as SudoWorkerSession;

    const sessions = new Map<true | string, SudoWorkerSession>([
      [true, fakeSession],
    ]);

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/a.conf', content: Buffer.from('a'), sudo: true },
      { targetPath: '/etc/b.conf', content: Buffer.from('b'), sudo: true },
      { targetPath: '/etc/c.conf', content: Buffer.from('c'), sudo: true },
    ];

    let caught: unknown;
    try {
      await sudoAtomicWrite(targets, [], sessions);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SudoWritePartialError);
    const err = caught as SudoWritePartialError;
    expect(err.message).toBe('disk full');
    expect(err.writtenPaths).toEqual(['/etc/a.conf', '/etc/b.conf']);
  });

  it('accumulates writtenPaths across multiple identities — first identity success + second identity partial', async () => {
    // trustedUids must include 0 and the current process UID to pass the ancestor
    // safety check on /etc (owned by root), mirroring what buildTrustedUids returns.
    const currentUid =
      typeof process.getuid === 'function' ? process.getuid() : 0;
    const baseTrusted = new Set([0, currentUid]);

    // Identity `true` (root): all 2 ops succeed.
    const rootExecMock = vi.fn(() =>
      Promise.resolve([{ ok: true }, { ok: true }]),
    );
    const rootSession = {
      exec: rootExecMock,
      close: vi.fn(),
      trustedUids: baseTrusted,
      sudo: true as const,
    } as unknown as SudoWorkerSession;

    // Identity "admin": first op ok, second fails.
    const adminExecMock = vi.fn(() =>
      Promise.resolve([{ ok: true }, { ok: false, error: 'no space left' }]),
    );
    const adminSession = {
      exec: adminExecMock,
      close: vi.fn(),
      trustedUids: new Set([...baseTrusted, 500]),
      sudo: 'admin' as const,
    } as unknown as SudoWorkerSession;

    const sessions = new Map<true | string, SudoWorkerSession>([
      [true, rootSession],
      ['admin', adminSession],
    ]);

    const targets: SudoWriteTarget[] = [
      { targetPath: '/etc/root-a.conf', content: Buffer.from('a'), sudo: true },
      { targetPath: '/etc/root-b.conf', content: Buffer.from('b'), sudo: true },
      {
        targetPath: '/etc/admin-a.conf',
        content: Buffer.from('c'),
        sudo: 'admin',
      },
      {
        targetPath: '/etc/admin-b.conf',
        content: Buffer.from('d'),
        sudo: 'admin',
      },
    ];

    let caught: unknown;
    try {
      await sudoAtomicWrite(targets, [], sessions);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SudoWritePartialError);
    const err = caught as SudoWritePartialError;
    expect(err.message).toBe('no space left');
    // root-a and root-b landed (identity 1 all ok); admin-a landed (identity 2 first ok)
    expect(err.writtenPaths).toEqual([
      '/etc/root-a.conf',
      '/etc/root-b.conf',
      '/etc/admin-a.conf',
    ]);
  });
});
