import * as path from 'path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  sudoAtomicDelete,
  sudoAtomicWrite,
  sudoRead,
  sudoReadlink,
  sudoFileExists,
  sudoUserArgs,
  SudoWriteTarget,
} from '../src/writer';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => SpawnSyncReturns<Buffer>
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
});

afterEach(() => {
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

describe('sudoRead', () => {
  it('returns stdout buffer on success', () => {
    mockSpawnSync.mockReturnValue(okResult('hello'));
    const result = sudoRead(true, '/etc/passwd');
    expect(result?.toString()).toBe('hello');
  });

  it('returns null when cat fails', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(sudoRead(true, '/etc/passwd')).toBeNull();
  });

  it('uses cat with -u args for named user', () => {
    mockSpawnSync.mockReturnValue(okResult('data'));
    sudoRead('nobody', '/tmp/file');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      expect.arrayContaining(['-u', 'nobody', 'cat', '--']),
      expect.any(Object),
    );
  });
});

describe('sudoReadlink', () => {
  it('returns trimmed symlink target on success', () => {
    mockSpawnSync.mockReturnValue(okResult('/etc/hosts\n'));
    expect(sudoReadlink(true, '/etc/link')).toBe('/etc/hosts');
  });

  it('returns null when readlink exits non-zero', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(sudoReadlink(true, '/etc/link')).toBeNull();
  });

  it('calls sudo readlink with resolved path for root', () => {
    mockSpawnSync.mockReturnValue(okResult('/target'));
    sudoReadlink(true, '/etc/link');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['readlink', path.resolve('/etc/link')],
      { stdio: ['inherit', 'pipe', 'ignore'] },
    );
  });

  it('calls sudo -u <name> readlink for a named user', () => {
    mockSpawnSync.mockReturnValue(okResult('/target'));
    sudoReadlink('nobody', '/etc/link');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-u', 'nobody', 'readlink', path.resolve('/etc/link')],
      { stdio: ['inherit', 'pipe', 'ignore'] },
    );
  });

  it('throws when spawnSync returns an error', () => {
    mockSpawnSync.mockReturnValue({
      ...failResult(),
      error: new Error('ENOENT'),
    });
    expect(() => sudoReadlink(true, '/etc/link')).toThrow(
      'sudo readlink failed',
    );
  });
});

describe('sudoFileExists', () => {
  it('returns true when test -e exits 0', () => {
    mockSpawnSync.mockReturnValue(okResult());
    expect(sudoFileExists(true, '/etc/hosts')).toBe(true);
  });

  it('returns false when test -e exits non-zero', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(sudoFileExists(true, '/no/such/file')).toBe(false);
  });
});

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
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  });

  it('encodes all ops in a single JSON input for the worker', async () => {
    mockSpawnSync.mockReturnValue(workerOkResult(2));

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
    const { ops } = JSON.parse(
      (sudoCalls[0][2] as { input: string }).input,
    ) as { ops: Array<{ type: string; targetPath: string }> };
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
    mockSpawnSync.mockReturnValue(workerOkResult(1));

    const target: SudoWriteTarget = {
      targetPath: '/etc/link',
      content: Buffer.from('/etc/hosts'),
      symlinkTarget: '/etc/hosts',
      sudo: true,
    };
    await sudoAtomicWrite([target]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    const { ops } = JSON.parse(
      (sudoCalls[0][2] as { input: string }).input,
    ) as { ops: Array<{ type: string; symlinkTarget?: string }> };
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
    mockSpawnSync.mockReturnValue(workerOkResult(1));

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('data'),
      sudo: true,
      backupPath: '/etc/test.conf.bak',
    };
    await sudoAtomicWrite([target]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    const { ops } = JSON.parse(
      (sudoCalls[0][2] as { input: string }).input,
    ) as { ops: Array<{ backupPath?: string }> };
    expect(ops[0].backupPath).toBe('/etc/test.conf.bak');
  });
});

describe.skipIf(isWindows)('sudoAtomicDelete', () => {
  it('returns immediately and makes no spawnSync calls for empty list', () => {
    sudoAtomicDelete([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('sends a delete op to the worker for a single path', () => {
    mockSpawnSync.mockReturnValue(workerOkResult(1));

    sudoAtomicDelete([['/etc/stale.conf', true]]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    const { ops } = JSON.parse(
      (sudoCalls[0][2] as { input: string }).input,
    ) as { ops: Array<{ type: string; targetPath: string }> };
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'delete',
      targetPath: '/etc/stale.conf',
    });
  });

  it('batches multiple deletions with the same identity into one worker call', () => {
    mockSpawnSync.mockReturnValue(workerOkResult(3));

    sudoAtomicDelete([
      ['/etc/a.conf', true],
      ['/etc/b.conf', true],
      ['/etc/c.conf', true],
    ]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(1);
    const { ops } = JSON.parse(
      (sudoCalls[0][2] as { input: string }).input,
    ) as { ops: Array<{ type: string }> };
    expect(ops).toHaveLength(3);
    for (const op of ops) expect(op.type).toBe('delete');
  });

  it('makes separate worker calls for different sudo identities', () => {
    mockSpawnSync.mockReturnValue(workerOkResult(1));

    sudoAtomicDelete([
      ['/etc/a.conf', true],
      ['/etc/b.conf', 'www-data'],
    ]);

    const sudoCalls = mockSpawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'sudo',
    );
    expect(sudoCalls).toHaveLength(2);
  });

  it('throws when the worker reports a failed op (default strict mode)', () => {
    const body = JSON.stringify({
      results: [{ ok: false, error: 'permission denied' }],
    });
    mockSpawnSync.mockReturnValue({
      ...workerOkResult(0),
      stdout: Buffer.from(body),
      output: [null, Buffer.from(body), null],
    });

    expect(() => sudoAtomicDelete([['/etc/locked.conf', true]])).toThrow(
      'permission denied',
    );
  });

  it('warns (does not throw) when the worker reports a failed op in bestEffort mode', () => {
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
      expect(() =>
        sudoAtomicDelete([['/etc/locked.conf', true]], true),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('permission denied'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
