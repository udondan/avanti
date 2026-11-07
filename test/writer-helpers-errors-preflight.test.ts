// Error paths of the sudo pre-flight helpers: ancestor directory safety,
// trusted UID resolution, worker location and Node.js binary resolution. The
// filesystem calls they make are wrapped so each case can describe a fake
// directory tree; `id -u` is answered by a mocked spawnSync.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { checkAncestorsSafe } from '../src/writer/dir-safety';
import { buildTrustedUids } from '../src/writer/trusted-uids';
import { prepareWorkerExec } from '../src/writer/worker-staging';
import { resolveNodeExec } from '../src/writer/node-exec';

const mockLstat = fs.lstatSync as unknown as MockInstance;
const mockStat = fs.statSync as unknown as MockInstance;
const mockExists = fs.existsSync as unknown as MockInstance;
const mockRealpath = fs.realpathSync as unknown as MockInstance;
const mockSpawnSync = spawnSync as unknown as MockInstance;

// The real implementations the fs wrappers delegate to between tests.
type Impl = NonNullable<ReturnType<MockInstance['getMockImplementation']>>;
const fsMocks = [mockLstat, mockStat, mockExists, mockRealpath];
const realImpls = new Map<MockInstance, Impl | undefined>(
  fsMocks.map((m) => [m, m.getMockImplementation()]),
);

const isWindows = process.platform === 'win32';
const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fake`), { code });
}

interface FakeStat {
  mode?: number;
  uid?: number;
  symlink?: boolean;
}

// A fake directory tree: every path maps to its lstat and (for symlinks) the
// stat of the link target. Paths not listed are root-owned 0755 directories.
interface FakeEntry {
  lstat: FakeStat | string;
  stat?: FakeStat | string;
}

function statsOf(s: FakeStat): object {
  return {
    mode: s.mode ?? 0o40755,
    uid: s.uid,
    isSymbolicLink: () => s.symlink === true,
  };
}

function fakeTree(entries: Record<string, FakeEntry>): void {
  const lookup = (p: string, which: 'lstat' | 'stat'): object => {
    const entry = entries[p];
    const value = entry ? (entry[which] ?? entry.lstat) : { uid: 0 };
    if (typeof value === 'string') throw errno(value);
    return statsOf(value);
  };
  mockLstat.mockImplementation((p: string) => lookup(p, 'lstat'));
  mockStat.mockImplementation((p: string) => lookup(p, 'stat'));
}

const TRUSTED = new Set([0, 501]);

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
  for (const m of fsMocks) {
    m.mockReset();
    const impl = realImpls.get(m);
    if (impl) m.mockImplementation(impl);
  }
  mockSpawnSync.mockReset();
  delete process.env.AVANTI_NODE_EXEC;
});

// The fake tree uses POSIX paths; path.resolve on Windows would add a drive.
describe.skipIf(isWindows)('checkAncestorsSafe', () => {
  const check = (trusted: Set<number> | undefined, checked?: Set<string>) =>
    checkAncestorsSafe('/a/b/target', trusted, 'target', checked);

  it('accepts root-owned ancestors, also without a trusted UID set', () => {
    fakeTree({});
    expect(() => check(TRUSTED)).not.toThrow();
    expect(() => check(undefined)).not.toThrow();
    expect(mockLstat.mock.calls.map((c) => c[0] as string)).toEqual([
      '/',
      '/a',
      '/a/b',
      '/',
      '/a',
      '/a/b',
    ]);
  });

  it('skips directories that were already checked and records new ones', () => {
    fakeTree({});
    const checked = new Set(['/', '/a']);
    check(TRUSTED, checked);
    expect(mockLstat.mock.calls.map((c) => c[0] as string)).toEqual(['/a/b']);
    expect([...checked]).toEqual(['/', '/a', '/a/b']);
  });

  it('rejects a world-writable ancestor without the sticky bit', () => {
    fakeTree({ '/a': { lstat: { mode: 0o40777, uid: 0 } } });
    expect(() => check(undefined)).toThrow(
      'sudo write: target ancestor directory /a is group- or world-writable; cannot safely create a temp file here (TOCTOU risk).',
    );
  });

  it('accepts a world-writable ancestor with the sticky bit', () => {
    fakeTree({ '/a': { lstat: { mode: 0o41777, uid: 0 } } });
    expect(() => check(TRUSTED)).not.toThrow();
  });

  it('skips the mode check on Windows', () => {
    fakeTree({ '/a': { lstat: { mode: 0o40777, uid: 0 } } });
    setPlatform('win32');
    expect(() => check(TRUSTED)).not.toThrow();
  });

  it('fails closed when the owner UID is unknown', () => {
    fakeTree({ '/a': { lstat: { uid: undefined } } });
    expect(() => check(TRUSTED)).toThrow(
      'sudo write: target ancestor directory /a owner UID could not be determined',
    );
    // Without a trusted set the owner is not checked at all.
    expect(() => check(undefined)).not.toThrow();
  });

  it('rejects an ancestor owned by an untrusted UID', () => {
    fakeTree({ '/a/b': { lstat: { uid: 1234 } } });
    expect(() => check(TRUSTED)).toThrow(
      'sudo write: target ancestor directory /a/b is owned by UID 1234, not a trusted identity',
    );
  });

  it('skips ancestors that do not exist yet or cannot be read', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
      fakeTree({ '/a': { lstat: code }, '/a/b': { lstat: code } });
      expect(() => check(TRUSTED)).not.toThrow();
    }
  });

  it('rethrows an unexpected lstat error', () => {
    fakeTree({ '/a': { lstat: 'EIO' } });
    expect(() => check(TRUSTED)).toThrow('EIO: fake');
  });

  describe('symlinked ancestors', () => {
    it('accepts a trusted symlink to a trusted, safe directory', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 501 }, stat: { uid: 0 } },
      });
      expect(() => check(TRUSTED)).not.toThrow();
      expect(mockStat).toHaveBeenCalledWith('/a');
    });

    it('checks the mode of the link target', () => {
      fakeTree({
        '/a': {
          lstat: { symlink: true, uid: 0, mode: 0o120777 },
          stat: { uid: 0, mode: 0o40777 },
        },
      });
      expect(() => check(undefined)).toThrow(
        'target ancestor directory /a is group- or world-writable',
      );
    });

    it('rejects a link target owned by an untrusted UID', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 0 }, stat: { uid: 4321 } },
      });
      expect(() => check(TRUSTED)).toThrow(
        'sudo write: target ancestor directory /a symlink target is owned by UID 4321, not a trusted identity',
      );
    });

    it('rejects a symlink owned by an untrusted UID', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 4321 }, stat: { uid: 0 } },
      });
      expect(() => check(TRUSTED)).toThrow(
        'sudo write: target ancestor directory /a is owned by UID 4321',
      );
    });

    it('validates the symlink owner when the target is unreadable', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 4321 }, stat: 'EACCES' },
      });
      let thrown: unknown;
      try {
        check(TRUSTED);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toMatch(
        /^sudo write: target ancestor directory \/a symlink is owned by UID 4321, not a trusted identity/,
      );
      expect((thrown as Error).cause).toMatchObject({ code: 'EACCES' });
    });

    it('skips an unreadable target behind a trusted symlink', () => {
      for (const code of ['EACCES', 'EPERM']) {
        fakeTree({
          '/a': { lstat: { symlink: true, uid: 501 }, stat: code },
        });
        expect(() => check(TRUSTED)).not.toThrow();
        // Without a trusted set there is nothing to validate either.
        fakeTree({
          '/a': { lstat: { symlink: true, uid: 4321 }, stat: code },
        });
        expect(() => check(undefined)).not.toThrow();
      }
    });

    it('fails closed for a dangling symlink', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 0 }, stat: 'ENOENT' },
      });
      expect(() => check(TRUSTED)).toThrow(
        'sudo write: target ancestor directory /a symlink target owner UID could not be determined',
      );
      // Without a trusted set the unknown mode and owner are not rejected.
      expect(() => check(undefined)).not.toThrow();
    });

    it('rethrows an unexpected error while following the symlink', () => {
      fakeTree({
        '/a': { lstat: { symlink: true, uid: 0 }, stat: 'ELOOP' },
      });
      expect(() => check(TRUSTED)).toThrow('ELOOP: fake');
    });
  });
});

describe('buildTrustedUids', () => {
  const ownUid = typeof process.getuid === 'function' ? [process.getuid()] : [];

  it('trusts root and the invoking user for root sudo', () => {
    expect([...buildTrustedUids(true)]).toEqual([...new Set([0, ...ownUid])]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('adds the UID of a named sudo user', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from('1001\n') });
    expect(buildTrustedUids('deploy').has(1001)).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'id',
      ['-u', 'deploy'],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('warns when id -u fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSpawnSync.mockReturnValue({ status: 1, stdout: Buffer.from('') });
    const trusted = buildTrustedUids('ghost');
    expect([...trusted]).toEqual([...new Set([0, ...ownUid])]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve UID for sudo user "ghost"'),
    );
  });

  it('warns when id -u prints something that is not a number', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from('n/a\n') });
    const trusted = buildTrustedUids('weird');
    expect(trusted.size).toBe(new Set([0, ...ownUid]).size);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sudo user "weird" (id -u failed)'),
    );
  });
});

describe('prepareWorkerExec', () => {
  it('tells the user to build when the compiled worker is missing', () => {
    mockExists.mockReturnValue(false);
    expect(() => prepareWorkerExec(true)).toThrow(
      /^privileged worker not found at .*privileged-worker\.js; run `mise run build` first$/,
    );
  });
});

describe('resolveNodeExec', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('rejects an AVANTI_NODE_EXEC override that is not executable', () => {
    process.env.AVANTI_NODE_EXEC = 'avanti-test-missing-node-binary';
    expect(() => resolveNodeExec(true)).toThrow(
      'AVANTI_NODE_EXEC is set to "avanti-test-missing-node-binary" but the binary is not executable or does not exist',
    );
  });

  it('names root sudo and the macOS search directories when nothing is found', () => {
    mockRealpath.mockImplementation((p: string) => {
      throw errno(`ENOENT ${p}`);
    });
    setPlatform('darwin');
    expect(() => resolveNodeExec(true)).toThrow(
      'No root-owned Node.js binary (v18+) found in /usr/bin, /usr/local/bin, /opt/homebrew/bin, /bin for root sudo. On NixOS',
    );
  });

  it('searches only the standard directories on other platforms', () => {
    mockRealpath.mockImplementation((p: string) => {
      throw errno(`ENOENT ${p}`);
    });
    setPlatform('linux');
    expect(() => resolveNodeExec('www-data')).toThrow(
      "found in /usr/bin, /usr/local/bin, /bin for named-user sudo ('www-data')",
    );
  });
});
