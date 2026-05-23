import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  sudoAuth,
  sudoAtomicWrite,
  sudoDelete,
  sudoRead,
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

describe('sudoAuth', () => {
  it('calls sudo -v for root', () => {
    mockSpawnSync.mockReturnValue(okResult());
    sudoAuth(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-v'],
      expect.any(Object),
    );
  });

  it('calls sudo -u <name> -v for a named user', () => {
    mockSpawnSync.mockReturnValue(okResult());
    sudoAuth('nobody');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-u', 'nobody', '-v'],
      expect.any(Object),
    );
  });

  it('throws when sudo -v fails', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(() => sudoAuth()).toThrow('sudo authentication failed');
  });
});

describe('sudoRead', () => {
  it('returns buffer on success', () => {
    mockSpawnSync.mockReturnValue(okResult('hello'));
    const result = sudoRead(true, '/etc/passwd');
    expect(result?.toString()).toBe('hello');
  });

  it('returns null on failure', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(sudoRead(true, '/etc/passwd')).toBeNull();
  });

  it('uses -u args for named user', () => {
    mockSpawnSync.mockReturnValue(okResult('data'));
    sudoRead('nobody', '/tmp/file');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-u', 'nobody', 'cat', '--', '/tmp/file'],
      expect.any(Object),
    );
  });
});

describe('sudoDelete', () => {
  it('calls sudo rm -f for root', () => {
    mockSpawnSync.mockReturnValue(okResult());
    sudoDelete('/tmp/file', true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['rm', '-f', '--', '/tmp/file'],
      expect.any(Object),
    );
  });

  it('calls sudo -u <name> rm -f for named user', () => {
    mockSpawnSync.mockReturnValue(okResult());
    sudoDelete('/tmp/file', 'www-data');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-u', 'www-data', 'rm', '-f', '--', '/tmp/file'],
      expect.any(Object),
    );
  });

  it('warns on failure instead of throwing', () => {
    mockSpawnSync.mockReturnValue(failResult());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => sudoDelete('/tmp/file', true)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
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

describe('sudoAtomicWrite — mv path', () => {
  it('calls mkdir, mktemp, tee, mv, chmod in order for a new root-owned file', () => {
    const calls: string[][] = [];
    mockSpawnSync.mockImplementation(
      (_cmd: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('mktemp')) return okResult('/etc/.avanti-tmp');
        if (args.includes('stat')) return okResult('644');
        if (args.includes('test') && args.includes('-L')) return failResult();
        if (args.includes('test') && args.includes('-d')) return failResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('hello'),
      sudo: true,
    };
    sudoAtomicWrite([target]);

    const flat = calls.map((a) => a.join(' '));
    expect(flat.some((c) => c.includes('mkdir'))).toBe(true);
    expect(flat.some((c) => c.includes('mktemp'))).toBe(true);
    expect(flat.some((c) => c.includes('tee'))).toBe(true);
    expect(flat.some((c) => c.includes('mv'))).toBe(true);
    expect(flat.some((c) => c.includes('chmod'))).toBe(true);
  });

  it('cleans up temp file on tee failure', () => {
    const calls: string[][] = [];
    mockSpawnSync.mockImplementation(
      (_cmd: unknown, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('mktemp')) return okResult('/etc/.avanti-tmp');
        if (args.includes('stat')) return okResult('');
        if (args.includes('tee')) return failResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/etc/test.conf',
      content: Buffer.from('hello'),
      sudo: true,
    };
    expect(() => sudoAtomicWrite([target])).toThrow('sudo write failed');
    const flat = calls.map((a) => a.join(' '));
    expect(
      flat.some((c) => c.includes('rm') && c.includes('.avanti-tmp')),
    ).toBe(true);
  });

  it('uses -u args for a named-user target', () => {
    const calls: string[][] = [];
    mockSpawnSync.mockImplementation(
      (_cmd: unknown, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('mktemp')) return okResult('/tmp/.avanti-tmp');
        if (args.includes('stat')) return okResult('');
        if (args.includes('-L')) return failResult();
        if (args.includes('-d')) return failResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/tmp/test.txt',
      content: Buffer.from('hi'),
      sudo: 'nobody',
    };
    sudoAtomicWrite([target]);
    for (const args of calls) {
      expect(args[0]).toBe('-u');
      expect(args[1]).toBe('nobody');
    }
  });

  it('replaces a symlink-to-dir by removing it first before mv', () => {
    const calls: string[][] = [];
    mockSpawnSync.mockImplementation(
      (_cmd: unknown, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('mktemp')) return okResult('/etc/.avanti-tmp');
        if (args.includes('stat')) return okResult('');
        if (args.includes('-L') && args.some((a) => a.includes('/etc/link')))
          return okResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/etc/link',
      content: Buffer.from('data'),
      sudo: true,
    };
    sudoAtomicWrite([target]);
    const flat = calls.map((a) => a.join(' '));
    const rmIdx = flat.findIndex(
      (c) => c.includes('rm') && c.includes('/etc/link'),
    );
    const mvIdx = flat.findIndex(
      (c) => c.includes('mv') && c.includes('/etc/link'),
    );
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(mvIdx).toBeGreaterThan(rmIdx);
  });
});
