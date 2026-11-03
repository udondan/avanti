import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readlinkSync: vi.fn(actual.readlinkSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

import * as fs from 'fs';
import {
  buildNewFileDiff,
  computeDeleteDiff,
  computeDiff,
  computeSymlinkDiff,
  formatDiff,
  printDiffs,
  type FileDiff,
} from '../src/diff';

const mockLstat = fs.lstatSync as unknown as MockInstance;
const mockReadlink = fs.readlinkSync as unknown as MockInstance;
const mockReadFile = fs.readFileSync as unknown as MockInstance;

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('diff edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-diff-render-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockLstat.mockClear();
    mockReadlink.mockClear();
    mockReadFile.mockClear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computeDeleteDiff', () => {
    it.skipIf(process.platform === 'win32')(
      'renders a delete patch for a symlink',
      () => {
        const p = path.join(tmpDir, 'link');
        fs.symlinkSync('some/target', p);
        const d = computeDeleteDiff(p);
        expect(d.isSymlink).toBe(true);
        expect(d.isDelete).toBe(true);
        expect(d.patch).toContain('-> some/target');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'marks a symlink unreadable when readlink fails with EACCES',
      () => {
        const p = path.join(tmpDir, 'link');
        fs.symlinkSync('some/target', p);
        mockReadlink.mockImplementationOnce(() => {
          throw errno('EACCES');
        });
        const d = computeDeleteDiff(p);
        expect(d).toMatchObject({
          isDelete: true,
          isUnreadable: true,
          isSymlink: true,
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rethrows other readlink errors',
      () => {
        const p = path.join(tmpDir, 'link');
        fs.symlinkSync('some/target', p);
        mockReadlink.mockImplementationOnce(() => {
          throw errno('EIO');
        });
        expect(() => computeDeleteDiff(p)).toThrow('EIO');
      },
    );
  });

  describe('computeDiff', () => {
    it('treats an EACCES lstat as unreadable with lstatFailed', () => {
      mockLstat.mockImplementationOnce(() => {
        throw errno('EACCES');
      });
      const d = computeDiff(path.join(tmpDir, 'x'), Buffer.from('new'));
      expect(d).toMatchObject({
        isNew: false,
        isUnreadable: true,
        lstatFailed: true,
        hasChanges: true,
      });
    });

    it('rethrows other lstat errors', () => {
      mockLstat.mockImplementationOnce(() => {
        throw errno('EIO');
      });
      expect(() =>
        computeDiff(path.join(tmpDir, 'x'), Buffer.from('n')),
      ).toThrow('EIO');
    });

    it.skipIf(process.platform === 'win32')(
      'treats a dangling symlink as empty old content',
      () => {
        const p = path.join(tmpDir, 'dangling');
        fs.symlinkSync(path.join(tmpDir, 'missing'), p);
        const d = computeDiff(p, Buffer.from('hello\n'));
        expect(d.isNew).toBe(false);
        expect(d.contentChanged).toBe(true);
        expect(d.patch).toContain('+hello');
      },
    );

    it('marks the file unreadable when reading fails with EPERM', () => {
      const p = path.join(tmpDir, 'f');
      fs.writeFileSync(p, 'old');
      mockReadFile.mockImplementationOnce(() => {
        throw errno('EPERM');
      });
      const d = computeDiff(p, Buffer.from('new'));
      expect(d.isUnreadable).toBe(true);
      expect(d.lstatFailed).toBeUndefined();
    });

    it('rethrows other read errors', () => {
      const p = path.join(tmpDir, 'f');
      fs.writeFileSync(p, 'old');
      mockReadFile.mockImplementationOnce(() => {
        throw errno('EIO');
      });
      expect(() => computeDiff(p, Buffer.from('new'))).toThrow('EIO');
    });

    it.skipIf(process.platform === 'win32')(
      'skips mode detection when the second lstat fails with EACCES',
      () => {
        const p = path.join(tmpDir, 'f');
        fs.writeFileSync(p, 'same');
        const real = mockLstat.getMockImplementation()!;
        mockLstat.mockImplementationOnce(real).mockImplementationOnce(() => {
          throw errno('EACCES');
        });
        const d = computeDiff(p, Buffer.from('same'), '0600');
        expect(d.modeChange).toBeUndefined();
        expect(d.hasChanges).toBe(false);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rethrows other errors from the mode lstat',
      () => {
        const p = path.join(tmpDir, 'f');
        fs.writeFileSync(p, 'same');
        const real = mockLstat.getMockImplementation()!;
        mockLstat.mockImplementationOnce(real).mockImplementationOnce(() => {
          throw errno('EIO');
        });
        expect(() => computeDiff(p, Buffer.from('same'), '0600')).toThrow(
          'EIO',
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'reports a mode change alongside unreadable content',
      () => {
        const p = path.join(tmpDir, 'f');
        fs.writeFileSync(p, 'x');
        fs.chmodSync(p, 0o644);
        mockReadFile.mockImplementationOnce(() => {
          throw errno('EACCES');
        });
        const d = computeDiff(p, Buffer.from('y'), '0600');
        expect(d.isUnreadable).toBe(true);
        expect(d.modeChange).toEqual({ from: 0o644, to: 0o600 });
      },
    );
  });

  describe('buildNewFileDiff', () => {
    it('builds a text new-file diff', () => {
      const d = buildNewFileDiff('/x/y.txt', Buffer.from('hi\n'), {
        from: 0o644,
        to: 0o600,
      });
      expect(d).toMatchObject({ isNew: true, hasChanges: true });
      expect(d.patch).toContain('+hi');
      expect(d.modeChange).toEqual({ from: 0o644, to: 0o600 });
    });

    it('builds a binary new-file diff', () => {
      const d = buildNewFileDiff('/x/y.bin', Buffer.from([0, 1, 2, 0]));
      expect(d).toMatchObject({ isNew: true, isBinary: true, patch: '' });
    });
  });

  describe('computeSymlinkDiff', () => {
    it('reports lstatFailed when lstat fails with EPERM', () => {
      mockLstat.mockImplementationOnce(() => {
        throw errno('EPERM');
      });
      expect(computeSymlinkDiff(path.join(tmpDir, 'l'), 't')).toMatchObject({
        isUnreadable: true,
        lstatFailed: true,
        isSymlink: true,
      });
    });

    it('rethrows other lstat errors', () => {
      mockLstat.mockImplementationOnce(() => {
        throw errno('EIO');
      });
      expect(() => computeSymlinkDiff(path.join(tmpDir, 'l'), 't')).toThrow(
        'EIO',
      );
    });

    it.skipIf(process.platform === 'win32')(
      'labels a non-regular, non-directory target as a special file',
      () => {
        const p = path.join(tmpDir, 'fake');
        fs.writeFileSync(p, '');
        const real = fs.lstatSync(p);
        mockLstat.mockImplementationOnce(() => ({
          ...real,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => false,
        }));
        const d = computeSymlinkDiff(p, 't');
        expect(d.patch).toContain('[special file]');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'marks unreadable when readlink fails with EACCES',
      () => {
        const p = path.join(tmpDir, 'l');
        fs.symlinkSync('old', p);
        mockReadlink.mockImplementationOnce(() => {
          throw errno('EACCES');
        });
        expect(computeSymlinkDiff(p, 'new')).toMatchObject({
          isUnreadable: true,
          isSymlink: true,
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rethrows other readlink errors',
      () => {
        const p = path.join(tmpDir, 'l');
        fs.symlinkSync('old', p);
        mockReadlink.mockImplementationOnce(() => {
          throw errno('EIO');
        });
        expect(() => computeSymlinkDiff(p, 'new')).toThrow('EIO');
      },
    );
  });

  describe('formatDiff', () => {
    const base: FileDiff = {
      targetPath: '/t/f',
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
    };

    it('renders an error for a symlink over a directory', () => {
      const out = strip(
        formatDiff({ ...base, isSymlink: true, isDirectory: true }),
      );
      expect(out).toContain('target is an existing directory');
    });

    it('renders unreadable symlink updates and deletes', () => {
      expect(
        strip(formatDiff({ ...base, isSymlink: true, isUnreadable: true })),
      ).toContain('+++ /t/f\n@@ symlink (existing state unreadable) @@');
      expect(
        strip(
          formatDiff({
            ...base,
            isSymlink: true,
            isUnreadable: true,
            isDelete: true,
          }),
        ),
      ).toContain('+++ /dev/null\n@@ symlink deleted');
    });

    it('renders unreadable file updates with mode lines', () => {
      const out = strip(
        formatDiff({
          ...base,
          isUnreadable: true,
          modeChange: { from: 0o644, to: 0o600 },
        }),
      );
      expect(out).toBe(
        '--- /t/f\n+++ /t/f\n-old mode 000644\n+new mode 000600\n' +
          '@@ file updated (existing content unreadable — diff unavailable) @@',
      );
    });

    it('renders unreadable file deletes', () => {
      const out = strip(
        formatDiff({ ...base, isUnreadable: true, isDelete: true }),
      );
      expect(out).toBe(
        '--- /t/f\n+++ /dev/null\n@@ file deleted (unreadable — no diff available) @@',
      );
    });

    it('falls through to mode-only rendering when unreadable content is unchanged', () => {
      const out = strip(
        formatDiff({
          ...base,
          isUnreadable: true,
          contentChanged: false,
          modeChange: { from: 0o644, to: 0o600 },
        }),
      );
      expect(out).toBe(
        '--- /t/f\n+++ /t/f\n-old mode 000644\n+new mode 000600',
      );
    });

    it('renders a mode-only binary change', () => {
      const out = strip(
        formatDiff({
          ...base,
          isBinary: true,
          contentChanged: false,
          modeChange: { from: 0o755, to: 0o644 },
        }),
      );
      expect(out).toBe(
        '--- /t/f\n+++ /t/f\n-old mode 000755\n+new mode 000644',
      );
    });

    it('renders nothing for a binary diff with neither content nor mode changes', () => {
      expect(
        formatDiff({ ...base, isBinary: true, contentChanged: false }),
      ).toBe('');
    });
  });

  describe('printDiffs', () => {
    it('prints "No changes." when nothing changed', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      printDiffs([
        {
          targetPath: '/t/f',
          isNew: false,
          hasChanges: false,
          contentChanged: false,
          patch: '',
        },
      ]);
      expect(log).toHaveBeenCalledWith('No changes.');
    });

    it('prints each changed diff', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      printDiffs([
        {
          targetPath: '/t/a',
          isNew: false,
          hasChanges: true,
          contentChanged: false,
          patch: '',
          modeChange: { from: 0o644, to: 0o600 },
        },
        {
          targetPath: '/t/b',
          isNew: false,
          hasChanges: false,
          contentChanged: false,
          patch: '',
        },
      ]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(strip(log.mock.calls[0][0] as string)).toContain('/t/a');
    });
  });
});
