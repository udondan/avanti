import * as path from 'path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  sudoAuth,
  sudoAtomicWrite,
  sudoDelete,
  sudoRead,
  sudoReadlink,
  sudoFileExists,
  sudoUserArgs,
  sudoRun,
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

describe('sudoAuth', () => {
  it.skipIf(isWindows)('calls sudo -v for root', () => {
    mockSpawnSync.mockReturnValue(okResult());
    sudoAuth(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-v'],
      expect.any(Object),
    );
  });

  it.skipIf(isWindows)('calls sudo -u <name> -v for a named user', () => {
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
    if (isWindows) {
      expect(() => sudoAuth()).toThrow('sudo is not supported on Windows');
    } else {
      expect(() => sudoAuth()).toThrow('sudo authentication failed');
    }
  });
});

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
      expect.any(Object),
    );
  });

  it('calls sudo -u <name> readlink for a named user', () => {
    mockSpawnSync.mockReturnValue(okResult('/target'));
    sudoReadlink('nobody', '/etc/link');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['-u', 'nobody', 'readlink', path.resolve('/etc/link')],
      expect.any(Object),
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
        // UID stat (-c %u): return 0 (root owns /etc)
        if (args.includes('stat') && args.includes('%u')) return okResult('0');
        // mode stat (-c %a or -f %Lp): return 644 (no group/world write)
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

  it.skipIf(process.platform === 'linux')(
    'on macOS/BSD, removes symlink-to-dir before mv',
    () => {
      const calls: string[][] = [];
      const resolvedLink = path.resolve('/etc/link');
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          calls.push([...args]);
          if (args.includes('mktemp')) return okResult('/etc/.avanti-tmp');
          if (args.includes('stat')) return okResult('');
          // -L: is a symlink
          if (args.includes('-L') && args.some((a) => a === resolvedLink))
            return okResult();
          // -d: symlink target is a directory
          if (args.includes('-d') && args.some((a) => a === resolvedLink))
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
        (c) => c.includes('rm') && c.includes(resolvedLink),
      );
      const mvIdx = flat.findIndex(
        (c) => c.includes('mv') && c.includes(resolvedLink),
      );
      expect(rmIdx).toBeGreaterThanOrEqual(0);
      expect(mvIdx).toBeGreaterThan(rmIdx);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'on Linux, symlinks are replaced atomically without pre-rm (mv -T)',
    () => {
      const calls: string[][] = [];
      const resolvedLink = path.resolve('/etc/link');
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          calls.push([...args]);
          if (args.includes('mktemp')) return okResult('/etc/.avanti-tmp');
          if (args.includes('stat')) return okResult('');
          // -L: is a symlink
          if (args.includes('-L') && args.some((a) => a === resolvedLink))
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
      // No pre-rm on Linux: mv -T replaces the symlink atomically
      expect(
        flat.some((c) => c.includes('rm') && c.includes(resolvedLink)),
      ).toBe(false);
      const mvIdx = flat.findIndex(
        (c) => c.includes('mv') && c.includes('-T') && c.includes(resolvedLink),
      );
      expect(mvIdx).toBeGreaterThanOrEqual(0);
    },
  );
});

describe('sudoAtomicWrite writeInPlace', () => {
  const isWindows = process.platform === 'win32';

  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    mockSpawnSync.mockReset();
  });

  it.skipIf(isWindows)(
    'writeInPlace: calls sudo tee with resolved path',
    () => {
      const calls: string[][] = [];
      const resolvedTarget = path.resolve('/etc/test.conf');
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          calls.push([...args]);
          // -L: not a symlink
          if (args.includes('-L')) return failResult();
          // -e: file does not exist (new file)
          if (args.includes('-e')) return failResult();
          return okResult();
        },
      );

      const target: SudoWriteTarget = {
        targetPath: '/etc/test.conf',
        content: Buffer.from('hello'),
        sudo: true,
        writeInPlace: true,
      };
      sudoAtomicWrite([target]);
      const flat = calls.map((a) => a.join(' '));
      expect(
        flat.some((c) => c.includes('tee') && c.includes(resolvedTarget)),
      ).toBe(true);
    },
  );

  it.skipIf(isWindows)('writeInPlace: rejects symlinks', () => {
    mockSpawnSync.mockImplementation(
      (_cmd: unknown, args: readonly string[]) => {
        // -L: is a symlink
        if (args.includes('-L')) return okResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/etc/link',
      content: Buffer.from('data'),
      sudo: true,
      writeInPlace: true,
    };
    expect(() => sudoAtomicWrite([target])).toThrow(
      'is a symlink; refusing to follow',
    );
  });

  it.skipIf(isWindows)('writeInPlace: rejects non-regular files', () => {
    mockSpawnSync.mockImplementation(
      (_cmd: unknown, args: readonly string[]) => {
        // -L: not a symlink
        if (args.includes('-L')) return failResult();
        // -e: file exists
        if (args.includes('-e')) return okResult();
        // -f: not a regular file (e.g. FIFO)
        if (args.includes('-f')) return failResult();
        return okResult();
      },
    );

    const target: SudoWriteTarget = {
      targetPath: '/etc/fifo',
      content: Buffer.from('data'),
      sudo: true,
      writeInPlace: true,
    };
    expect(() => sudoAtomicWrite([target])).toThrow(
      'is not a regular file; refusing to write',
    );
  });
});

describe('sudoRun — mode-only chmod path', () => {
  it.skipIf(isWindows)(
    'calls sudo chmod with padded octal mode for root',
    () => {
      mockSpawnSync.mockReturnValue(okResult());
      sudoRun(true, ['chmod', '--', '0644', '/etc/test.conf']);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'sudo',
        ['chmod', '--', '0644', '/etc/test.conf'],
        expect.any(Object),
      );
    },
  );

  it.skipIf(isWindows)(
    'calls sudo -u <user> chmod for named-user mode-only change',
    () => {
      mockSpawnSync.mockReturnValue(okResult());
      sudoRun('nobody', ['chmod', '--', '0644', '/etc/test.conf']);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'sudo',
        ['-u', 'nobody', 'chmod', '--', '0644', '/etc/test.conf'],
        expect.any(Object),
      );
    },
  );

  it('throws when sudo chmod fails', () => {
    mockSpawnSync.mockReturnValue(failResult());
    expect(() =>
      sudoRun(true, ['chmod', '--', '0644', '/etc/test.conf']),
    ).toThrow();
  });
});

describe('sudoAtomicWrite — symlink path', () => {
  it.skipIf(isWindows)(
    'stages new symlink via mktemp+mv (atomic) not ln -sf',
    () => {
      const calls: string[][] = [];
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          calls.push([...args]);
          if (args.includes('stat') && args.includes('%u'))
            return okResult('0');
          if (args.includes('stat')) return okResult('644');
          if (args.includes('test') && args.includes('-L')) return failResult();
          if (args.includes('test') && args.includes('-d')) return failResult();
          if (args.includes('test') && args.includes('-f')) return failResult();
          if (args.includes('mktemp'))
            return okResult('/etc/.avanti-symlink-tmp');
          return okResult();
        },
      );

      const target: SudoWriteTarget = {
        targetPath: '/etc/link',
        content: Buffer.from('/etc/hosts'),
        symlinkTarget: '/etc/hosts',
        sudo: true,
      };
      sudoAtomicWrite([target]);
      const flat = calls.map((a) => a.join(' '));
      expect(flat.some((c) => c.includes('mkdir'))).toBe(true);
      // Must NOT use ln -sf (non-atomic)
      expect(flat.some((c) => c.includes('ln') && c.includes('-sf'))).toBe(
        false,
      );
      // Must create temp symlink with ln -s <target> <tmppath>
      expect(
        flat.some(
          (c) =>
            c.includes('ln') &&
            c.includes('-s') &&
            c.includes('/etc/hosts') &&
            c.includes('/etc/.avanti-symlink-tmp'),
        ),
      ).toBe(true);
      // Must atomically rename temp path over destination
      expect(
        flat.some(
          (c) =>
            c.includes('mv') &&
            c.includes('/etc/.avanti-symlink-tmp') &&
            c.includes(path.resolve('/etc/link')),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(isWindows)(
    'throws when target path is an existing real directory',
    () => {
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          if (args.includes('stat') && args.includes('%u'))
            return okResult('0');
          if (args.includes('stat')) return okResult('644');
          if (args.includes('test') && args.includes('-L')) return failResult();
          if (args.includes('test') && args.includes('-d')) return okResult();
          return okResult();
        },
      );

      const target: SudoWriteTarget = {
        targetPath: '/etc/conf.d',
        content: Buffer.from('/etc/hosts'),
        symlinkTarget: '/etc/hosts',
        sudo: true,
      };
      expect(() => sudoAtomicWrite([target])).toThrow('is a directory');
    },
  );

  it.skipIf(isWindows)(
    'backs up an existing symlink then replaces atomically via mktemp+mv',
    () => {
      const calls: string[][] = [];
      mockSpawnSync.mockImplementation(
        (_cmd: unknown, args: readonly string[]) => {
          calls.push([...args]);
          if (args.includes('stat') && args.includes('%u'))
            return okResult('0');
          if (args.includes('stat')) return okResult('644');
          // Target is a symlink (dir-refusal and backup-detection checks)
          if (args.includes('test') && args.includes('-L')) return okResult();
          if (args.includes('test') && args.includes('-d')) return failResult();
          if (args.includes('test') && args.includes('-f')) return failResult();
          // Distinguish backup mktemp from new-symlink mktemp by template pattern
          if (args.includes('mktemp')) {
            const tmpl = args.find((a) => a.includes('.avanti-'));
            return okResult(
              tmpl?.includes('backup')
                ? '/etc/.avanti-backup-tmp'
                : '/etc/.avanti-symlink-tmp',
            );
          }
          if (args.includes('readlink')) return okResult('/etc/old-target');
          return okResult();
        },
      );

      const target: SudoWriteTarget = {
        targetPath: '/etc/link',
        content: Buffer.from('/etc/new-target'),
        symlinkTarget: '/etc/new-target',
        backupPath: '/etc/link.bak',
        sudo: true,
      };
      sudoAtomicWrite([target]);
      const flat = calls.map((a) => a.join(' '));
      // Symlink backups use ln -s with an absolute target (not cp -pP) so the
      // backup resolves correctly from the backup directory.
      expect(flat.some((c) => c.includes('cp') && c.includes('-pP'))).toBe(
        false,
      );
      expect(
        flat.some(
          (c) =>
            c.includes('ln') &&
            c.includes('-s') &&
            c.includes('/etc/old-target'),
        ),
      ).toBe(true);
      // Final replacement must NOT use ln -sf (non-atomic)
      expect(flat.some((c) => c.includes('ln') && c.includes('-sf'))).toBe(
        false,
      );
      // Must stage new symlink at temp path and rename atomically
      expect(
        flat.some(
          (c) =>
            c.includes('ln') &&
            c.includes('-s') &&
            c.includes('/etc/new-target') &&
            c.includes('/etc/.avanti-symlink-tmp'),
        ),
      ).toBe(true);
      expect(
        flat.some(
          (c) =>
            c.includes('mv') &&
            c.includes('/etc/.avanti-symlink-tmp') &&
            c.includes(path.resolve('/etc/link')),
        ),
      ).toBe(true);
    },
  );
});
