import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Wrap the fs calls atomicWrite makes so individual tests can inject OS-level
// failures (EACCES, ENOSPC, ELOOP races, …) that cannot be produced reliably
// without root. Every wrapper delegates to the real implementation by default.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    constants: { ...actual.constants },
    symlinkSync: vi.fn(actual.symlinkSync),
    copyFileSync: vi.fn(actual.copyFileSync),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    rmSync: vi.fn(actual.rmSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});

import * as fs from 'fs';
import { atomicWrite, AtomicWritePartialError } from '../src/writer';

const mockSymlink = fs.symlinkSync as unknown as MockInstance;
const mockCopyFile = fs.copyFileSync as unknown as MockInstance;
const mockOpen = fs.openSync as unknown as MockInstance;
const mockFstat = fs.fstatSync as unknown as MockInstance;
const mockRm = fs.rmSync as unknown as MockInstance;
const mockLstat = fs.lstatSync as unknown as MockInstance;
const mocks = [
  mockSymlink,
  mockCopyFile,
  mockOpen,
  mockFstat,
  mockRm,
  mockLstat,
];
const realImpls = new Map(
  mocks.map((m) => [m, m.getMockImplementation()!] as const),
);

const isWindows = process.platform === 'win32';
const originalPlatform = process.platform;
const realONoFollow = (fs.constants as Record<string, number>).O_NOFOLLOW;

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p });
}

let tmpDir: string;
let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-writer-fserr-'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (realONoFollow !== undefined) {
    (fs.constants as Record<string, number>).O_NOFOLLOW = realONoFollow;
  }
  for (const m of mocks) m.mockImplementation(realImpls.get(m)!);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const leftovers = (): string[] =>
  fs.readdirSync(tmpDir).filter((n) => n.includes('.avanti-'));

describe('atomicWrite — symlink staging', () => {
  it('refuses symlink writes on Windows', () => {
    setPlatform('win32');
    expect(() =>
      atomicWrite([
        {
          targetPath: path.join(tmpDir, 'l'),
          content: Buffer.alloc(0),
          symlinkTarget: 'x',
        },
      ]),
    ).toThrow('symlink writes are not supported on Windows');
  });

  it.skipIf(isWindows)('retries a temp-link name collision (EEXIST)', () => {
    const real = realImpls.get(mockSymlink)!;
    mockSymlink
      .mockImplementationOnce(() => {
        throw errno('EEXIST');
      })
      .mockImplementation(real);
    const dest = path.join(tmpDir, 'l');
    atomicWrite([
      { targetPath: dest, content: Buffer.alloc(0), symlinkTarget: 't' },
    ]);
    expect(fs.readlinkSync(dest)).toBe('t');
    expect(mockSymlink).toHaveBeenCalledTimes(2);
  });

  it.skipIf(isWindows)('propagates other symlink staging errors', () => {
    mockSymlink.mockImplementationOnce(() => {
      throw errno('EACCES');
    });
    expect(() =>
      atomicWrite([
        {
          targetPath: path.join(tmpDir, 'l'),
          content: Buffer.alloc(0),
          symlinkTarget: 't',
        },
      ]),
    ).toThrow('EACCES');
    expect(fs.existsSync(path.join(tmpDir, 'l'))).toBe(false);
  });
});

describe('atomicWrite — backups', () => {
  it('skips backing up a symlink on Windows', () => {
    const dest = path.join(tmpDir, 'f');
    fs.writeFileSync(dest, 'old');
    const backupPath = path.join(tmpDir, 'bak', 'f');
    // Pretend dest is a symlink and we run on Windows: the backup is skipped
    // with a warning and no backup directory is created.
    const realLstat = realImpls.get(mockLstat) as typeof fs.lstatSync;
    mockLstat.mockImplementation(((p: fs.PathLike, o?: fs.StatOptions) => {
      const st = realLstat(p, o as fs.StatOptions & { bigint?: false });
      if (p === dest && st) {
        return Object.assign(Object.create(st) as fs.Stats, {
          isFile: () => false,
          isSymbolicLink: () => true,
        });
      }
      return st;
    }) as typeof fs.lstatSync);
    setPlatform('win32');
    try {
      atomicWrite([
        { targetPath: dest, content: Buffer.from('new'), backupPath },
      ]);
    } finally {
      setPlatform(originalPlatform);
    }
    expect(String(warn.mock.calls[0][0])).toContain(
      `cannot back up symlink ${dest} on Windows`,
    );
    expect(fs.existsSync(path.dirname(backupPath))).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it.skipIf(isWindows)('retries a backup symlink temp collision', () => {
    const dest = path.join(tmpDir, 'l');
    fs.symlinkSync('old-target', dest);
    const backupPath = path.join(tmpDir, 'l.bak');
    const real = realImpls.get(mockSymlink)!;
    mockSymlink
      .mockImplementationOnce(() => {
        throw errno('EEXIST');
      })
      .mockImplementation(real);
    atomicWrite([{ targetPath: dest, content: Buffer.from('x'), backupPath }]);
    expect(fs.readlinkSync(backupPath)).toBe(path.join(tmpDir, 'old-target'));
  });

  it.skipIf(isWindows)('propagates other backup symlink errors', () => {
    const dest = path.join(tmpDir, 'l');
    fs.symlinkSync('old-target', dest);
    mockSymlink.mockImplementationOnce(() => {
      throw errno('ENOSPC');
    });
    expect(() =>
      atomicWrite([
        {
          targetPath: dest,
          content: Buffer.from('x'),
          backupPath: path.join(tmpDir, 'l.bak'),
        },
      ]),
    ).toThrow('ENOSPC');
    // destination untouched, staged temp removed
    expect(fs.readlinkSync(dest)).toBe('old-target');
    expect(leftovers()).toEqual([]);
  });

  it('retries a backup copy collision (EEXIST)', () => {
    const dest = path.join(tmpDir, 'f');
    fs.writeFileSync(dest, 'old');
    const backupPath = path.join(tmpDir, 'f.bak');
    const real = realImpls.get(mockCopyFile)!;
    mockCopyFile
      .mockImplementationOnce(() => {
        throw errno('EEXIST');
      })
      .mockImplementation(real);
    atomicWrite([
      { targetPath: dest, content: Buffer.from('new'), backupPath },
    ]);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('old');
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it('removes a partial backup temp and rethrows on copy failure', () => {
    const dest = path.join(tmpDir, 'f');
    fs.writeFileSync(dest, 'old');
    mockCopyFile.mockImplementationOnce((_src: string, tmp: string) => {
      fs.writeFileSync(tmp, 'partial');
      throw errno('ENOSPC');
    });
    expect(() =>
      atomicWrite([
        {
          targetPath: dest,
          content: Buffer.from('new'),
          backupPath: path.join(tmpDir, 'f.bak'),
        },
      ]),
    ).toThrow('ENOSPC');
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });
});

describe('atomicWrite — in-place writes', () => {
  it.skipIf(isWindows)(
    'reports an ELOOP race on open as a symlink refusal',
    () => {
      const dest = path.join(tmpDir, 'f');
      fs.writeFileSync(dest, 'old');
      mockOpen.mockImplementationOnce(() => {
        throw errno('ELOOP');
      });
      const err = (() => {
        try {
          atomicWrite([
            {
              targetPath: dest,
              content: Buffer.from('new'),
              writeInPlace: true,
            },
          ]);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(AtomicWritePartialError);
      expect((err as Error).message).toBe(
        `writeInPlace: ${dest} is a symlink; refusing to follow`,
      );
    },
  );

  it.skipIf(isWindows)('rethrows other open errors', () => {
    const dest = path.join(tmpDir, 'f');
    fs.writeFileSync(dest, 'old');
    mockOpen.mockImplementationOnce(() => {
      throw errno('EACCES');
    });
    expect(() =>
      atomicWrite([
        { targetPath: dest, content: Buffer.from('new'), writeInPlace: true },
      ]),
    ).toThrow('EACCES');
  });

  it.skipIf(isWindows)('stringifies non-Error failures', () => {
    const dest = path.join(tmpDir, 'f');
    fs.writeFileSync(dest, 'old');
    mockOpen.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
      throw 'nope';
    });
    const err = (() => {
      try {
        atomicWrite([
          { targetPath: dest, content: Buffer.from('new'), writeInPlace: true },
        ]);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AtomicWritePartialError);
    expect((err as Error).message).toBe('nope');
    expect((err as AtomicWritePartialError).writtenPaths).toEqual([]);
  });

  it.skipIf(isWindows)(
    'refuses when the opened fd is not a regular file',
    () => {
      const dest = path.join(tmpDir, 'f');
      fs.writeFileSync(dest, 'old');
      mockFstat.mockImplementationOnce(
        () => ({ isFile: () => false }) as fs.Stats,
      );
      expect(() =>
        atomicWrite([
          { targetPath: dest, content: Buffer.from('new'), writeInPlace: true },
        ]),
      ).toThrow(
        `writeInPlace: ${dest} is not a regular file; refusing to write`,
      );
      expect(fs.readFileSync(dest, 'utf8')).toBe('');
    },
  );

  describe('without O_NOFOLLOW (Windows code path)', () => {
    beforeEach(() => {
      delete (fs.constants as Record<string, number>).O_NOFOLLOW;
    });

    it('writes the file and applies the mode via chmod', () => {
      const dest = path.join(tmpDir, 'sub', 'f');
      atomicWrite([
        {
          targetPath: dest,
          content: Buffer.from('hello'),
          writeInPlace: true,
          mode: '0600',
        },
      ]);
      expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
      if (!isWindows) expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    });

    it('writes without a mode for a new file', () => {
      const dest = path.join(tmpDir, 'g');
      atomicWrite([
        { targetPath: dest, content: Buffer.from('x'), writeInPlace: true },
      ]);
      expect(fs.readFileSync(dest, 'utf8')).toBe('x');
    });

    it.skipIf(isWindows)(
      'refuses a symlink that appears after pre-validation',
      () => {
        const dest = path.join(tmpDir, 'l');
        fs.writeFileSync(path.join(tmpDir, 'real'), 'r');
        // The pre-validation lstat sees a regular file; the Phase 4 lstat sees
        // the symlink that replaced it.
        const realLstat = realImpls.get(mockLstat) as typeof fs.lstatSync;
        let calls = 0;
        mockLstat.mockImplementation(((p: fs.PathLike, o?: fs.StatOptions) => {
          if (p === dest) {
            calls++;
            if (calls === 1) return undefined;
            fs.symlinkSync('real', dest);
          }
          return realLstat(p, o as fs.StatOptions & { bigint?: false });
        }) as typeof fs.lstatSync);
        expect(() =>
          atomicWrite([
            { targetPath: dest, content: Buffer.from('x'), writeInPlace: true },
          ]),
        ).toThrow(`writeInPlace: ${dest} is a symlink; refusing to follow`);
        expect(fs.readFileSync(path.join(tmpDir, 'real'), 'utf8')).toBe('r');
      },
    );
  });
});

describe('atomicWrite — deletions', () => {
  it('warns and continues when a deletion fails', () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    const real = realImpls.get(mockRm)!;
    mockRm.mockImplementation((p: string, o: unknown) => {
      if (p === a) throw new Error('busy');
      real(p, o);
    });
    atomicWrite([], [a, b]);
    expect(String(warn.mock.calls[0][0])).toBe(
      `Warning: could not delete ${a}: busy`,
    );
    expect(fs.existsSync(b)).toBe(false);
  });

  it('stringifies non-Error deletion failures', () => {
    const a = path.join(tmpDir, 'a');
    mockRm.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
      throw 'nope';
    });
    atomicWrite([], [a]);
    expect(String(warn.mock.calls[0][0])).toBe(
      `Warning: could not delete ${a}: nope`,
    );
  });
});
