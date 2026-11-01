import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dispatch,
  handleWriteMv,
  handleWriteInPlace,
  handleWriteSymlink,
} from '../src/privileged-worker';

// Error paths in the privileged worker depend on OS conditions that a
// non-root test run cannot produce (EACCES for root, ENOSPC, races between
// lstat and open, O_PATH availability, foreign ownership). Every fs function
// the worker calls is wrapped in a vi.fn that passes through to the real
// implementation by default; individual tests intercept specific calls.
const h = vi.hoisted(() => ({
  names: [
    'openSync',
    'closeSync',
    'fstatSync',
    'lstatSync',
    'statSync',
    'readSync',
    'writeSync',
    'writeFileSync',
    'renameSync',
    'symlinkSync',
    'unlinkSync',
    'readlinkSync',
    'fchmodSync',
    'chmodSync',
    'copyFileSync',
  ] as const,
  real: undefined as unknown as typeof import('fs'),
}));
type Wrapped = (typeof h.names)[number];

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  h.real = actual;
  const wrapped: Record<string, unknown> = {};
  for (const name of h.names) wrapped[name] = vi.fn(actual[name]);
  // A mutable copy so tests can toggle O_PATH availability.
  return { ...actual, ...wrapped, constants: { ...actual.constants } };
});

const realFs = h.real;
const WRAPPED = h.names;

const isWindows = process.platform === 'win32';
const MAX_READ = 100 * 1024 * 1024;
const C = realFs.constants;
const constants = fs.constants as Record<string, number | undefined>;
const ORIGINAL_O_PATH = constants.O_PATH;
// Linux's O_PATH value; used as a stand-in where the platform lacks it.
const FAKE_O_PATH = 0o10000000;

const PASS = Symbol('pass');
type Handler = (args: unknown[], n: number) => unknown;

function callReal(name: Wrapped, args: unknown[]): unknown {
  return (realFs[name] as (...a: unknown[]) => unknown)(...args);
}

// Intercepts calls to fs[name]; the handler receives the arguments and the
// 1-based index of the call (counted from installation). Returning PASS falls
// through to the real implementation.
function on(name: Wrapped, handler: Handler): void {
  let n = 0;
  (fs[name] as unknown as Mock).mockImplementation((...args: unknown[]) => {
    n++;
    const r = handler(args, n);
    return r === PASS ? callReal(name, args) : r;
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function fakeStats(o: {
  file?: boolean;
  dir?: boolean;
  link?: boolean | (() => boolean);
  size?: number;
  mode?: number;
  uid?: number;
}): fs.Stats {
  return {
    isFile: () => !!o.file,
    isDirectory: () => !!o.dir,
    isSymbolicLink: typeof o.link === 'function' ? o.link : () => !!o.link,
    size: o.size ?? 0,
    mode: o.mode ?? 0o100644,
    uid: o.uid ?? 0,
  } as unknown as fs.Stats;
}

const isNum = (f: unknown): f is number => typeof f === 'number';
const isReadOnly = (f: unknown): boolean =>
  isNum(f) &&
  (f & (C.O_WRONLY | C.O_RDWR)) === 0 &&
  (f & (ORIGINAL_O_PATH ?? FAKE_O_PATH)) === 0;
const isTruncWrite = (f: unknown): boolean => isNum(f) && (f & C.O_TRUNC) !== 0;
const isPlainWrite = (f: unknown): boolean =>
  isNum(f) && (f & C.O_WRONLY) !== 0 && (f & C.O_TRUNC) === 0;
const isOPath = (f: unknown): boolean =>
  isNum(f) && (f & (ORIGINAL_O_PATH ?? FAKE_O_PATH)) !== 0;

function b64(content: string): string {
  return Buffer.from(content).toString('base64');
}

function modeOf(p: string): number {
  return realFs.statSync(p).mode & 0o7777;
}

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
const myUid = process.getuid?.() ?? 0;
const trusted = (): Set<number> => new Set([0, myUid]);

beforeEach(() => {
  tmpDir = realFs.realpathSync(
    realFs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `avanti-priv-fs-${crypto.randomBytes(4).toString('hex')}-`,
      ),
    ),
  );
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const name of WRAPPED) {
    (fs[name] as unknown as Mock).mockImplementation(
      realFs[name] as (...a: unknown[]) => unknown,
    );
  }
  constants.O_PATH = ORIGINAL_O_PATH;
  vi.restoreAllMocks();
  realFs.rmSync(tmpDir, { recursive: true, force: true });
});

function leftovers(dir: string, prefix: string): string[] {
  return realFs.readdirSync(dir).filter((f) => f.startsWith(prefix));
}

describe.skipIf(isWindows)('read / stat-read / readlink edge cases', () => {
  it('reports EISDIR when reading a directory', () => {
    expect(() => dispatch({ type: 'read', targetPath: tmpDir })).toThrow(
      expect.objectContaining({ code: 'EISDIR' }) as Error,
    );
  });

  it('reports ENOTREGFILE for special files', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    on('fstatSync', () => fakeStats({}));
    expect(() => dispatch({ type: 'read', targetPath: p })).toThrow(
      expect.objectContaining({ code: 'ENOTREGFILE' }) as Error,
    );
  });

  it('refuses files whose size exceeds the read limit', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    on('fstatSync', () => fakeStats({ file: true, size: MAX_READ + 1 }));
    expect(() => dispatch({ type: 'stat-read', targetPath: p })).toThrow(
      /exceeds the 100 MiB read limit/,
    );
  });

  it('refuses files that grow past the read limit while being read', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    on('readSync', () => MAX_READ + 1);
    expect(() => dispatch({ type: 'read', targetPath: p })).toThrow(
      /exceeds the 100 MiB read limit/,
    );
  });

  it('refuses symlink targets longer than the read limit', () => {
    on('readlinkSync', () => ({ length: MAX_READ + 1 }));
    expect(() =>
      dispatch({ type: 'readlink', targetPath: path.join(tmpDir, 'l') }),
    ).toThrow(/target exceeds the 100 MiB read limit/);
  });

  it('stat-read retries as a regular file when the symlink was swapped back (EINVAL)', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'regular');
    on('openSync', (_a, n) => {
      if (n === 1) throw errno('ELOOP');
      return PASS;
    });
    const r = dispatch({ type: 'stat-read', targetPath: p });
    expect(r).toMatchObject({ kind: 'read', isSymlink: false });
    if (r.kind === 'read') {
      expect(Buffer.from(r.contentB64, 'base64').toString()).toBe('regular');
    }
  });

  it('stat-read propagates readlink errors other than EINVAL', () => {
    on('openSync', () => {
      throw errno('ELOOP');
    });
    expect(() =>
      dispatch({ type: 'stat-read', targetPath: path.join(tmpDir, 'none') }),
    ).toThrow(expect.objectContaining({ code: 'ENOENT' }) as Error);
  });

  it('stat-read tolerates an lstat failure after readlink', () => {
    const target = path.join(tmpDir, 'real');
    const link = path.join(tmpDir, 'link');
    realFs.writeFileSync(target, 'x');
    realFs.symlinkSync(target, link);
    on('lstatSync', () => {
      throw errno('EIO');
    });
    const r = dispatch({ type: 'stat-read', targetPath: link });
    expect(r).toMatchObject({ kind: 'read', isSymlink: true, mode: undefined });
  });

  it('rejects unknown op types', () => {
    expect(() =>
      dispatch({ type: 'bogus', targetPath: tmpDir } as unknown as Parameters<
        typeof dispatch
      >[0]),
    ).toThrow(/unknown op type: bogus/);
  });
});

describe.skipIf(isWindows)('handleWriteMv edge cases', () => {
  it('rejects invalid base64 and removes the temp file', () => {
    const p = path.join(tmpDir, 'f');
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: p,
        contentB64: 'not base64!',
        defaultMode: '0644',
      }),
    ).toThrow(/invalid base64/);
    expect(leftovers(tmpDir, '.avanti-')).toHaveLength(0);
    expect(realFs.existsSync(p)).toBe(false);
  });

  it('rejects an invalid mode string', () => {
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: path.join(tmpDir, 'f'),
        contentB64: b64('x'),
        mode: '0o64x',
        defaultMode: '0644',
      }),
    ).toThrow(/invalid mode: 0o64x/);
  });

  it('accepts 0o-prefixed modes', () => {
    const p = path.join(tmpDir, 'f');
    handleWriteMv({
      type: 'write-mv',
      targetPath: p,
      contentB64: b64('x'),
      mode: '0o640',
      defaultMode: '0644',
    });
    expect(modeOf(p)).toBe(0o640);
  });

  it('rethrows unexpected errors while reading the existing mode', () => {
    on('lstatSync', () => {
      throw errno('EACCES');
    });
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: path.join(tmpDir, 'f'),
        contentB64: b64('x'),
        defaultMode: '0644',
      }),
    ).toThrow(expect.objectContaining({ code: 'EACCES' }) as Error);
  });

  it('falls back to defaultMode for a dangling symlink target and strips special bits from symlink targets', () => {
    const real = path.join(tmpDir, 'real');
    realFs.writeFileSync(real, 'x');
    realFs.chmodSync(real, 0o2750);
    const link = path.join(tmpDir, 'link');
    realFs.symlinkSync(real, link);
    handleWriteMv({
      type: 'write-mv',
      targetPath: link,
      contentB64: b64('new'),
      defaultMode: '0600',
    });
    expect(realFs.lstatSync(link).isFile()).toBe(true);
    expect(modeOf(link)).toBe(0o750);

    const dangling = path.join(tmpDir, 'dangling');
    realFs.symlinkSync(path.join(tmpDir, 'missing'), dangling);
    handleWriteMv({
      type: 'write-mv',
      targetPath: dangling,
      contentB64: b64('new'),
      defaultMode: '0600',
    });
    expect(modeOf(dangling)).toBe(0o600);
  });

  it('replaces a symlink and backs it up as an absolute symlink', () => {
    const link = path.join(tmpDir, 'link');
    realFs.symlinkSync('elsewhere', link);
    const backupPath = path.join(tmpDir, 'bk', 'link.bak');
    handleWriteMv({
      type: 'write-mv',
      targetPath: link,
      contentB64: b64('content'),
      defaultMode: '0644',
      backupPath,
    });
    expect(realFs.readFileSync(link, 'utf8')).toBe('content');
    expect(realFs.readlinkSync(backupPath)).toBe(
      path.join(tmpDir, 'elsewhere'),
    );
  });

  it('removes the committed backup when the final rename fails', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'original');
    const backupPath = path.join(tmpDir, 'f.bak');
    on('renameSync', (_a, n) => {
      if (n === 2) throw errno('EXDEV');
      return PASS;
    });
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: p,
        contentB64: b64('new'),
        defaultMode: '0644',
        backupPath,
      }),
    ).toThrow(/EXDEV/);
    expect(realFs.existsSync(backupPath)).toBe(false);
    expect(realFs.readFileSync(p, 'utf8')).toBe('original');
    expect(leftovers(tmpDir, '.avanti-')).toHaveLength(0);
  });

  it('runs ancestor checks before and after mkdir when trusted UIDs are given', () => {
    const p = path.join(tmpDir, 'sub', 'f');
    realFs.mkdirSync(path.dirname(p));
    realFs.writeFileSync(p, 'old');
    const backupPath = path.join(tmpDir, 'bk', 'f.bak');
    handleWriteMv(
      {
        type: 'write-mv',
        targetPath: p,
        contentB64: b64('new'),
        defaultMode: '0644',
        backupPath,
      },
      trusted(),
    );
    expect(realFs.readFileSync(backupPath, 'utf8')).toBe('old');
  });

  it('throws when the backup invariant (pre-read link target) is violated', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    let linkCalls = 0;
    on('lstatSync', (args, n) => {
      // Call 1: getExistingMode; call 2: the pre-rename lstat whose result
      // is handed to backupTarget. Report "not a symlink" until backupTarget
      // asks, so the caller never pre-reads the link target.
      if (n === 2 && args[0] === p) {
        return fakeStats({ file: true, link: () => ++linkCalls > 2 });
      }
      return PASS;
    });
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: p,
        contentB64: b64('new'),
        defaultMode: '0644',
        backupPath: path.join(tmpDir, 'bk'),
      }),
    ).toThrow(/preobtainedLinkTarget must be provided/);
  });
});

describe.skipIf(isWindows)('backups of regular files', () => {
  function writeInPlaceWithBackup(p: string, backupPath: string): void {
    handleWriteInPlace({
      type: 'write-in-place',
      targetPath: p,
      contentB64: b64('new'),
      defaultMode: '0644',
      backupPath,
    });
  }

  it('creates a backup for an existing file written in place', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const backupPath = path.join(tmpDir, 'f.bak');
    writeInPlaceWithBackup(p, backupPath);
    expect(realFs.readFileSync(backupPath, 'utf8')).toBe('old');
    expect(realFs.readFileSync(p, 'utf8')).toBe('new');
  });

  it('skips the backup when the source vanished before it could be opened', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const backupPath = path.join(tmpDir, 'f.bak');
    on('openSync', (_a, n) => {
      if (n === 1) throw errno('ENOENT');
      return PASS;
    });
    writeInPlaceWithBackup(p, backupPath);
    expect(realFs.existsSync(backupPath)).toBe(false);
    expect(realFs.readFileSync(p, 'utf8')).toBe('new');
  });

  it('propagates unexpected errors opening the backup source', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    on('openSync', (_a, n) => {
      if (n === 1) throw errno('EACCES');
      return PASS;
    });
    expect(() => writeInPlaceWithBackup(p, path.join(tmpDir, 'b'))).toThrow(
      /EACCES/,
    );
    expect(realFs.readFileSync(p, 'utf8')).toBe('old');
  });

  it('skips the backup when the opened source is not a regular file', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const backupPath = path.join(tmpDir, 'f.bak');
    on('fstatSync', (_a, n) => (n === 1 ? fakeStats({}) : PASS));
    writeInPlaceWithBackup(p, backupPath);
    expect(realFs.existsSync(backupPath)).toBe(false);
  });

  it('refuses a backup path that is a directory', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const backupDir = path.join(tmpDir, 'bkdir');
    realFs.mkdirSync(backupDir);
    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath: p,
        contentB64: b64('new'),
        defaultMode: '0644',
        backupPath: backupDir,
      }),
    ).toThrow(/backup path is a directory/);
    expect(realFs.readFileSync(p, 'utf8')).toBe('old');
  });

  it('cleans up the staged backup when copying fails', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const bkDir = path.join(tmpDir, 'bk');
    on('writeSync', () => {
      throw errno('ENOSPC');
    });
    on('closeSync', (args) => {
      // Exercise the best-effort close of the backup fd failing too.
      callReal('closeSync', args);
      throw errno('EBADF');
    });
    expect(() => writeInPlaceWithBackup(p, path.join(bkDir, 'f.bak'))).toThrow(
      /ENOSPC/,
    );
    expect(realFs.readdirSync(bkDir)).toHaveLength(0);
    expect(realFs.readFileSync(p, 'utf8')).toBe('old');
  });
});

describe.skipIf(isWindows)('backups of symlinks', () => {
  function writeSymlinkWithBackup(
    link: string,
    backupPath: string,
    uids?: Set<number>,
  ): void {
    handleWriteSymlink(
      {
        type: 'write-symlink',
        targetPath: link,
        symlinkTarget: '/new/target',
        backupPath,
      },
      uids,
    );
  }

  it('refuses a backup path that is a directory', () => {
    const link = path.join(tmpDir, 'l');
    realFs.symlinkSync('/old', link);
    const bkDir = path.join(tmpDir, 'bkdir');
    realFs.mkdirSync(bkDir);
    expect(() => writeSymlinkWithBackup(link, bkDir)).toThrow(
      /backup path is a directory/,
    );
  });

  it('runs ancestor checks for the backup when trusted UIDs are given', () => {
    const link = path.join(tmpDir, 'l');
    realFs.symlinkSync('/old', link);
    const backupPath = path.join(tmpDir, 'bk', 'l.bak');
    writeSymlinkWithBackup(link, backupPath, trusted());
    expect(realFs.readlinkSync(backupPath)).toBe('/old');
    expect(realFs.readlinkSync(link)).toBe('/new/target');
  });

  it('cleans up when staging the backup symlink fails', () => {
    const link = path.join(tmpDir, 'l');
    realFs.symlinkSync('/old', link);
    on('symlinkSync', () => {
      throw errno('ENOSPC');
    });
    expect(() =>
      writeSymlinkWithBackup(link, path.join(tmpDir, 'l.bak')),
    ).toThrow(/ENOSPC/);
    expect(leftovers(tmpDir, '.avanti-')).toHaveLength(0);
    expect(realFs.readlinkSync(link)).toBe('/old');
  });

  it('removes the backup and temp link when the final rename fails', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'old');
    const backupPath = path.join(tmpDir, 'f.bak');
    on('renameSync', (_a, n) => {
      if (n === 2) throw errno('EXDEV');
      return PASS;
    });
    expect(() => writeSymlinkWithBackup(p, backupPath)).toThrow(/EXDEV/);
    expect(realFs.existsSync(backupPath)).toBe(false);
    expect(leftovers(tmpDir, '.avanti-')).toHaveLength(0);
    expect(realFs.readFileSync(p, 'utf8')).toBe('old');
  });
});

describe.skipIf(isWindows)('handleDelete edge cases', () => {
  it('reports a clear error when the file became a directory before unlink', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    on('unlinkSync', () => {
      throw errno('EISDIR');
    });
    expect(() => dispatch({ type: 'delete', targetPath: p })).toThrow(
      /was replaced by a directory/,
    );
  });

  it('propagates other unlink errors', () => {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    on('unlinkSync', () => {
      throw errno('EPERM');
    });
    expect(() => dispatch({ type: 'delete', targetPath: p })).toThrow(/EPERM/);
  });

  it('deletes a symlink without touching its target', () => {
    const target = path.join(tmpDir, 't');
    const link = path.join(tmpDir, 'l');
    realFs.writeFileSync(target, 'x');
    realFs.symlinkSync(target, link);
    expect(dispatch({ type: 'delete', targetPath: link })).toEqual({
      kind: 'ok',
    });
    expect(realFs.existsSync(target)).toBe(true);
  });
});

describe.skipIf(isWindows)('ancestor safety checks', () => {
  function write(targetPath: string, uids: Set<number>): void {
    handleWriteMv(
      {
        type: 'write-mv',
        targetPath,
        contentB64: b64('x'),
        defaultMode: '0644',
      },
      uids,
    );
  }

  it('accepts a symlinked ancestor whose target is trusted', () => {
    const realDir = path.join(tmpDir, 'real');
    realFs.mkdirSync(realDir);
    const linkDir = path.join(tmpDir, 'link');
    realFs.symlinkSync(realDir, linkDir);
    write(path.join(linkDir, 'f'), trusted());
    expect(realFs.readFileSync(path.join(realDir, 'f'), 'utf8')).toBe('x');
  });

  it('refuses a dangling symlinked ancestor', () => {
    const linkDir = path.join(tmpDir, 'link');
    realFs.symlinkSync(path.join(tmpDir, 'missing'), linkDir);
    expect(() => write(path.join(linkDir, 'f'), trusted())).toThrow(
      /is a dangling symlink/,
    );
  });

  it('propagates unexpected stat errors on a symlinked ancestor', () => {
    const realDir = path.join(tmpDir, 'real');
    realFs.mkdirSync(realDir);
    const linkDir = path.join(tmpDir, 'link');
    realFs.symlinkSync(realDir, linkDir);
    on('statSync', (args) => {
      if (args[0] === linkDir) throw errno('EIO');
      return PASS;
    });
    expect(() => write(path.join(linkDir, 'f'), trusted())).toThrow(/EIO/);
  });

  it('refuses a symlinked ancestor whose target has an untrusted owner', () => {
    const realDir = path.join(tmpDir, 'real');
    realFs.mkdirSync(realDir);
    const linkDir = path.join(tmpDir, 'link');
    realFs.symlinkSync(realDir, linkDir);
    on('statSync', (args) => {
      if (args[0] === linkDir) {
        return fakeStats({ dir: true, mode: 0o40755, uid: 4242 });
      }
      return PASS;
    });
    expect(() => write(path.join(linkDir, 'f'), trusted())).toThrow(
      /symlink target owned by UID 4242, not trusted/,
    );
  });

  it('propagates unexpected lstat errors on an ancestor', () => {
    const sub = path.join(tmpDir, 'sub');
    on('lstatSync', (args) => {
      if (args[0] === sub) throw errno('EACCES');
      return PASS;
    });
    expect(() => write(path.join(sub, 'f'), trusted())).toThrow(/EACCES/);
  });

  it('refuses a group/world-writable ancestor without the sticky bit', () => {
    const sub = path.join(tmpDir, 'open');
    realFs.mkdirSync(sub);
    realFs.chmodSync(sub, 0o777);
    expect(() => write(path.join(sub, 'f'), trusted())).toThrow(
      /group\/world-writable without sticky bit/,
    );
  });

  it('refuses an ancestor owned by an untrusted UID', () => {
    on('lstatSync', (args) => {
      if (args[0] === tmpDir) {
        return fakeStats({ dir: true, mode: 0o40755, uid: 4242 });
      }
      return PASS;
    });
    expect(() => write(path.join(tmpDir, 'f'), trusted())).toThrow(
      /owned by UID 4242, not trusted/,
    );
  });
});

describe.skipIf(isWindows)('handleWriteInPlace edge cases', () => {
  function writeInPlace(p: string, extra: { backupPath?: string } = {}): void {
    handleWriteInPlace({
      type: 'write-in-place',
      targetPath: p,
      contentB64: b64('new'),
      defaultMode: '0644',
      ...extra,
    });
  }

  function existing(name = 'f', mode = 0o644): string {
    const p = path.join(tmpDir, name);
    realFs.writeFileSync(p, 'original');
    realFs.chmodSync(p, mode);
    return p;
  }

  it('refuses a target that is not a regular file', () => {
    const d = path.join(tmpDir, 'dir');
    realFs.mkdirSync(d);
    expect(() => writeInPlace(d)).toThrow(/is not a regular file/);
  });

  it('removes the new file stub when the initial write fails', () => {
    const p = path.join(tmpDir, 'new');
    on('writeFileSync', () => {
      throw errno('ENOSPC');
    });
    on('closeSync', (args) => {
      callReal('closeSync', args);
      throw errno('EBADF');
    });
    expect(() => writeInPlace(p)).toThrow(/ENOSPC/);
    expect(realFs.existsSync(p)).toBe(false);
  });

  it('refuses when the read-open finds a non-regular file', () => {
    const p = existing();
    on('fstatSync', (_a, n) => (n === 1 ? fakeStats({}) : PASS));
    expect(() => writeInPlace(p)).toThrow(/is not a regular file/);
  });

  it('refuses when a symlink was raced in before the read-open', () => {
    const p = existing();
    on('openSync', (args) => {
      if (args[0] === p && isReadOnly(args[1])) throw errno('ELOOP');
      return PASS;
    });
    expect(() => writeInPlace(p)).toThrow(/is a symlink; refusing to follow/);
  });

  it('refuses when the read-open is denied and lstat finds a non-regular file', () => {
    const p = existing();
    on('openSync', (args) => {
      if (args[0] === p && isReadOnly(args[1])) throw errno('EACCES');
      return PASS;
    });
    on('lstatSync', (_a, n) => (n === 2 ? fakeStats({}) : PASS));
    expect(() => writeInPlace(p)).toThrow(/is not a regular file/);
  });

  it('propagates write-open errors other than EACCES', () => {
    const p = existing();
    on('openSync', (args) => {
      if (isTruncWrite(args[1])) throw errno('EIO');
      return PASS;
    });
    expect(() => writeInPlace(p)).toThrow(/EIO/);
    expect(realFs.readFileSync(p, 'utf8')).toBe('original');
  });

  it('refuses when the write-open finds a non-regular file', () => {
    const p = existing();
    on('fstatSync', (_a, n) => (n === 2 ? fakeStats({}) : PASS));
    expect(() => writeInPlace(p)).toThrow(/is not a regular file after open/);
  });

  describe('temporary write-bit grant for named-user sudo', () => {
    beforeEach(() => {
      vi.spyOn(process, 'getuid').mockReturnValue(4242);
    });

    function denyFirstTruncOpen(p: string, alsoDenyRead = false): void {
      let truncCalls = 0;
      on('openSync', (args) => {
        if (args[0] === p && alsoDenyRead && isReadOnly(args[1])) {
          throw errno('EACCES');
        }
        if (args[0] === p && isTruncWrite(args[1]) && ++truncCalls === 1) {
          throw errno('EACCES');
        }
        return PASS;
      });
    }

    it('grants the write bit via the read fd and restores the mode', () => {
      const p = existing('f', 0o444);
      denyFirstTruncOpen(p);
      writeInPlace(p);
      expect(realFs.readFileSync(p, 'utf8')).toBe('new');
      expect(modeOf(p)).toBe(0o444);
    });

    it('does not grant the write bit when running as root', () => {
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      const p = existing();
      denyFirstTruncOpen(p);
      expect(() => writeInPlace(p)).toThrow(/EACCES/);
    });

    it('surfaces the original error when the fd-based grant fails', () => {
      const p = existing();
      denyFirstTruncOpen(p);
      on('fchmodSync', () => {
        throw errno('EPERM');
      });
      expect(() => writeInPlace(p)).toThrow(/EACCES/);
    });

    it('restores the mode via the read fd when the retried open fails', () => {
      const p = existing('f', 0o444);
      on('openSync', (args) => {
        if (args[0] === p && isTruncWrite(args[1])) throw errno('EACCES');
        return PASS;
      });
      expect(() => writeInPlace(p)).toThrow(/EACCES/);
      expect(modeOf(p)).toBe(0o444);
      expect(realFs.readFileSync(p, 'utf8')).toBe('original');
    });

    it('reports a failure to restore the mode after the grant', () => {
      const p = existing();
      denyFirstTruncOpen(p);
      on('fchmodSync', (_a, n) => {
        if (n === 2) throw errno('EPERM');
        return PASS;
      });
      expect(() => writeInPlace(p)).toThrow(
        /failed to restore mode on .* after temporary write-bit grant/,
      );
    });

    describe('without a read fd', () => {
      it('grants the write bit via a write-only fd and restores via path', () => {
        const p = existing('f', 0o644);
        denyFirstTruncOpen(p, true);
        writeInPlace(p);
        expect(realFs.readFileSync(p, 'utf8')).toBe('new');
        expect(modeOf(p)).toBe(0o644);
      });

      it('refuses when a symlink was raced in before the write-only open', () => {
        const p = existing();
        on('openSync', (args) => {
          if (args[0] !== p) return PASS;
          if (isPlainWrite(args[1])) throw errno('ELOOP');
          if (isReadOnly(args[1]) || isTruncWrite(args[1]))
            throw errno('EACCES');
          return PASS;
        });
        expect(() => writeInPlace(p)).toThrow(/is a symlink/);
      });

      it('refuses when no fd-based chmod is possible', () => {
        const p = existing();
        on('openSync', (args) => {
          if (args[0] === p && typeof args[1] === 'number') {
            throw errno('EACCES');
          }
          return PASS;
        });
        expect(() => writeInPlace(p)).toThrow(
          /is not writable \(mode 644\) and no fd-based chmod path/,
        );
      });

      it('surfaces the original error when the write-only fd grant fails', () => {
        const p = existing();
        denyFirstTruncOpen(p, true);
        on('fchmodSync', () => {
          throw errno('EPERM');
        });
        on('closeSync', (args) => {
          callReal('closeSync', args);
          throw errno('EBADF');
        });
        expect(() => writeInPlace(p)).toThrow(/EACCES/);
      });

      it('restores the mode via path when the retried open fails', () => {
        const p = existing('f', 0o444);
        on('openSync', (args) => {
          if (args[0] !== p) return PASS;
          if (isReadOnly(args[1]) || isTruncWrite(args[1]))
            throw errno('EACCES');
          // A read fd stands in for the write-only fd: fchmod works on either.
          if (isPlainWrite(args[1])) return realFs.openSync(p, 'r');
          return PASS;
        });
        on('chmodSync', (_a, n) => {
          if (n === 2) throw errno('EPERM');
          return PASS;
        });
        expect(() => writeInPlace(p)).toThrow(/EACCES/);
        expect(modeOf(p)).toBe(0o444);
      });
    });
  });

  describe('restore after a failed write', () => {
    function failContentWrite(): void {
      on('writeFileSync', (args) => {
        if (typeof args[0] === 'number') throw errno('ENOSPC');
        return PASS;
      });
    }

    it('restores from the backup', () => {
      const p = existing();
      const backupPath = path.join(tmpDir, 'f.bak');
      failContentWrite();
      expect(() => writeInPlace(p, { backupPath })).toThrow(/ENOSPC/);
      expect(realFs.readFileSync(p, 'utf8')).toBe('original');
      expect(leftovers(tmpDir, '.avanti-')).toHaveLength(0);
    });

    it('reports when the target was replaced by a directory', () => {
      const p = existing();
      failContentWrite();
      on('copyFileSync', () => {
        throw errno('EISDIR');
      });
      expect(() =>
        writeInPlace(p, { backupPath: path.join(tmpDir, 'f.bak') }),
      ).toThrow(/ENOSPC/);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/was replaced by a directory; file is truncated/),
      );
    });

    it('reports other backup restore failures', () => {
      const p = existing();
      failContentWrite();
      on('copyFileSync', () => {
        throw errno('EACCES');
      });
      expect(() =>
        writeInPlace(p, { backupPath: path.join(tmpDir, 'f.bak') }),
      ).toThrow(/ENOSPC/);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/restore of .* from backup failed/),
      );
    });

    it('restores from the in-memory snapshot without a backup', () => {
      const p = existing();
      failContentWrite();
      on('closeSync', (args) => {
        callReal('closeSync', args);
        throw errno('EBADF');
      });
      expect(() => writeInPlace(p)).toThrow(/ENOSPC/);
      expect(realFs.readFileSync(p, 'utf8')).toBe('original');
    });

    it('restores an empty file from the in-memory snapshot', () => {
      const p = path.join(tmpDir, 'empty');
      realFs.writeFileSync(p, '');
      failContentWrite();
      expect(() => writeInPlace(p)).toThrow(/ENOSPC/);
      expect(realFs.readFileSync(p, 'utf8')).toBe('');
    });

    it('reports a failed in-memory restore', () => {
      const p = existing();
      on('writeFileSync', () => {
        throw errno('ENOSPC');
      });
      on('fchmodSync', () => {
        throw errno('EPERM');
      });
      expect(() => writeInPlace(p)).toThrow(/ENOSPC/);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/in-memory restore of .* failed/),
      );
    });

    it('reports when no restore is possible and restores the mode via path', () => {
      const p = existing();
      on('openSync', (args) => {
        if (args[0] === p && isReadOnly(args[1])) throw errno('EACCES');
        return PASS;
      });
      failContentWrite();
      on('chmodSync', () => {
        throw errno('EPERM');
      });
      expect(() => writeInPlace(p)).toThrow(/ENOSPC/);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/no restore is possible/),
      );
    });

    it('keeps new content when only the final chmod fails', () => {
      const p = existing();
      on('fchmodSync', () => {
        throw errno('EPERM');
      });
      expect(() =>
        handleWriteInPlace({
          type: 'write-in-place',
          targetPath: p,
          contentB64: b64('new'),
          mode: '0600',
          defaultMode: '0644',
        }),
      ).toThrow(/EPERM/);
      expect(realFs.readFileSync(p, 'utf8')).toBe('new');
    });
  });
});

describe.skipIf(isWindows)('chmod op', () => {
  function chmod(p: string, mode = '0600'): unknown {
    return dispatch({ type: 'chmod', targetPath: p, mode });
  }

  function existing(): string {
    const p = path.join(tmpDir, 'f');
    realFs.writeFileSync(p, 'x');
    realFs.chmodSync(p, 0o644);
    return p;
  }

  function denyOpen(p: string, pred: (flags: unknown) => boolean): void {
    on('openSync', (args) => {
      if (args[0] === p && pred(args[1])) throw errno('EACCES');
      return PASS;
    });
  }

  const denyReadWrite = (f: unknown): boolean =>
    isReadOnly(f) || isPlainWrite(f);

  it('skips a missing file', () => {
    expect(chmod(path.join(tmpDir, 'missing'))).toEqual({ kind: 'skipped' });
  });

  it('skips a symlink', () => {
    const link = path.join(tmpDir, 'l');
    realFs.symlinkSync(existing(), link);
    expect(chmod(link)).toEqual({ kind: 'skipped' });
  });

  it('propagates unexpected open errors', () => {
    const p = existing();
    on('openSync', () => {
      throw errno('EIO');
    });
    expect(() => chmod(p)).toThrow(/EIO/);
  });

  it('falls back to a write-only fd when the read-open is denied', () => {
    const p = existing();
    denyOpen(p, isReadOnly);
    expect(chmod(p)).toEqual({ kind: 'ok' });
    expect(modeOf(p)).toBe(0o600);
  });

  it('propagates write-only open errors other than EACCES', () => {
    const p = existing();
    on('openSync', (args) => {
      if (isReadOnly(args[1])) throw errno('EACCES');
      throw errno('EIO');
    });
    expect(() => chmod(p)).toThrow(/EIO/);
  });

  it('closes the fd and rethrows when fchmod fails', () => {
    const p = existing();
    on('fchmodSync', () => {
      throw errno('EPERM');
    });
    on('closeSync', (args) => {
      callReal('closeSync', args);
      throw errno('EBADF');
    });
    expect(() => chmod(p)).toThrow(/EPERM/);
  });

  describe('when both read and write opens are denied', () => {
    it('uses a path-based chmod when O_PATH is unavailable', () => {
      constants.O_PATH = undefined;
      const p = existing();
      denyOpen(p, denyReadWrite);
      expect(chmod(p)).toEqual({ kind: 'ok' });
      expect(modeOf(p)).toBe(0o600);
    });

    it('refuses the path-based chmod when the target is no longer a regular file', () => {
      constants.O_PATH = undefined;
      const p = existing();
      denyOpen(p, denyReadWrite);
      on('lstatSync', () => fakeStats({ link: true }));
      expect(() => chmod(p)).toThrow(/is not a regular file/);
    });

    describe('with O_PATH', () => {
      let decoy: string;

      beforeEach(() => {
        constants.O_PATH = ORIGINAL_O_PATH ?? FAKE_O_PATH;
        decoy = path.join(tmpDir, 'decoy');
        realFs.writeFileSync(decoy, 'decoy');
      });

      function opathOpen(p: string, onOPath: () => unknown): void {
        on('openSync', (args) => {
          if (args[0] === p && isOPath(args[1])) return onOPath();
          if (args[0] === p && denyReadWrite(args[1])) throw errno('EACCES');
          return PASS;
        });
      }

      it('chmods through /proc/self/fd', () => {
        const p = existing();
        opathOpen(p, () => realFs.openSync(decoy, 'r'));
        on('chmodSync', (args) => {
          if (String(args[0]).startsWith('/proc/self/fd/')) {
            return realFs.chmodSync(p, args[1] as number);
          }
          return PASS;
        });
        expect(chmod(p)).toEqual({ kind: 'ok' });
        expect(modeOf(p)).toBe(0o600);
        expect(modeOf(decoy)).not.toBe(0o600);
      });

      it('falls back to a path-based chmod when procfs is unavailable', () => {
        const p = existing();
        opathOpen(p, () => realFs.openSync(decoy, 'r'));
        on('chmodSync', (args) => {
          if (String(args[0]).startsWith('/proc/self/fd/')) {
            throw errno('ENOENT');
          }
          return PASS;
        });
        expect(chmod(p)).toEqual({ kind: 'ok' });
        expect(modeOf(p)).toBe(0o600);
      });

      it('falls back to a path-based chmod when O_PATH is not supported', () => {
        const p = existing();
        opathOpen(p, () => {
          throw errno('ENOTSUP');
        });
        expect(chmod(p)).toEqual({ kind: 'ok' });
        expect(modeOf(p)).toBe(0o600);
      });

      it('propagates resource errors from the O_PATH open', () => {
        const p = existing();
        opathOpen(p, () => {
          throw errno('EMFILE');
        });
        expect(() => chmod(p)).toThrow(/EMFILE/);
        expect(modeOf(p)).toBe(0o644);
      });

      it('refuses when the O_PATH fd is not a regular file', () => {
        const p = existing();
        opathOpen(p, () => realFs.openSync(tmpDir, 'r'));
        expect(() => chmod(p)).toThrow(/is not a regular file/);
        expect(modeOf(p)).toBe(0o644);
      });
    });
  });
});
