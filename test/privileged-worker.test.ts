import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleWriteMv,
  handleWriteInPlace,
  handleWriteSymlink,
  handleDelete,
  dispatch,
} from '../src/privileged-worker';

const isWindows = process.platform === 'win32';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `avanti-priv-worker-test-${crypto.randomBytes(4).toString('hex')}-`,
    ),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a temp content file and return its path. */
function writeContentSrc(content: string): string {
  const p = path.join(
    tmpDir,
    `.content-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// handleWriteMv
// ---------------------------------------------------------------------------

describe('handleWriteMv', () => {
  it('creates a new file with the given content at targetPath', () => {
    const targetPath = path.join(tmpDir, 'new-file.txt');
    const contentSrc = writeContentSrc('hello world');

    handleWriteMv({
      type: 'write-mv',
      targetPath,
      contentSrc,
      defaultMode: '0644',
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('hello world');
  });

  it.skipIf(isWindows)(
    'preserves the existing file mode when no mode is specified',
    () => {
      const targetPath = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(targetPath, 'old content');
      fs.chmodSync(targetPath, 0o755);

      const contentSrc = writeContentSrc('new content');
      handleWriteMv({
        type: 'write-mv',
        targetPath,
        contentSrc,
        defaultMode: '0644',
      });

      const mode = fs.statSync(targetPath).mode & 0o7777;
      expect(mode).toBe(0o755);
    },
  );

  it.skipIf(isWindows)(
    'uses defaultMode when target does not exist and no mode is given',
    () => {
      const targetPath = path.join(tmpDir, 'brand-new.txt');
      const contentSrc = writeContentSrc('content');

      handleWriteMv({
        type: 'write-mv',
        targetPath,
        contentSrc,
        defaultMode: '0640',
      });

      const mode = fs.statSync(targetPath).mode & 0o7777;
      expect(mode).toBe(0o640);
    },
  );

  it.skipIf(isWindows)(
    'uses the explicit mode from the op when provided',
    () => {
      const targetPath = path.join(tmpDir, 'explicit-mode.txt');
      // Create a pre-existing file with a different mode.
      fs.writeFileSync(targetPath, 'old');
      fs.chmodSync(targetPath, 0o755);

      const contentSrc = writeContentSrc('new');
      handleWriteMv({
        type: 'write-mv',
        targetPath,
        contentSrc,
        mode: '0600',
        defaultMode: '0644',
      });

      const mode = fs.statSync(targetPath).mode & 0o7777;
      expect(mode).toBe(0o600);
    },
  );

  it('creates parent directories if they do not exist', () => {
    const targetPath = path.join(tmpDir, 'deeply', 'nested', 'dir', 'file.txt');
    const contentSrc = writeContentSrc('deep');

    handleWriteMv({
      type: 'write-mv',
      targetPath,
      contentSrc,
      defaultMode: '0644',
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('deep');
  });

  it.skipIf(isWindows)(
    'creates a backup of an existing regular file at backupPath with same mode',
    () => {
      const targetPath = path.join(tmpDir, 'target.txt');
      fs.writeFileSync(targetPath, 'original content');
      fs.chmodSync(targetPath, 0o750);

      const backupPath = path.join(tmpDir, 'backups', 'target.txt.bak');
      const contentSrc = writeContentSrc('new content');

      handleWriteMv({
        type: 'write-mv',
        targetPath,
        contentSrc,
        defaultMode: '0644',
        backupPath,
      });

      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf8')).toBe('original content');
      const backupMode = fs.statSync(backupPath).mode & 0o7777;
      expect(backupMode).toBe(0o750);
    },
  );

  it('cleans up the temp file even when the write fails (target is a real directory)', () => {
    // Create a real directory at targetPath so rename will fail.
    const targetPath = path.join(tmpDir, 'iam-a-dir');
    fs.mkdirSync(targetPath);

    const contentSrc = writeContentSrc('content');

    expect(() =>
      handleWriteMv({
        type: 'write-mv',
        targetPath,
        contentSrc,
        defaultMode: '0644',
      }),
    ).toThrow();

    // Ensure no leftover .avanti-* temp files in tmpDir.
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('.avanti-'));
    expect(leftovers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleWriteInPlace
// ---------------------------------------------------------------------------

describe('handleWriteInPlace', () => {
  it('creates a new file with the given content', () => {
    const targetPath = path.join(tmpDir, 'inplace-new.txt');
    const contentSrc = writeContentSrc('inplace content');

    handleWriteInPlace({
      type: 'write-in-place',
      targetPath,
      contentSrc,
      defaultMode: '0644',
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('inplace content');
  });

  it.skipIf(isWindows)(
    'overwrites an existing file in-place preserving the inode',
    () => {
      const targetPath = path.join(tmpDir, 'inplace-existing.txt');
      fs.writeFileSync(targetPath, 'old content');
      const beforeIno = fs.statSync(targetPath).ino;

      const contentSrc = writeContentSrc('new content');
      handleWriteInPlace({
        type: 'write-in-place',
        targetPath,
        contentSrc,
        defaultMode: '0644',
      });

      const afterIno = fs.statSync(targetPath).ino;
      expect(afterIno).toBe(beforeIno);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('new content');
    },
  );

  it.skipIf(isWindows)('rejects a symlink at the target path', () => {
    const realFile = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(realFile, 'real');
    const symlink = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(realFile, symlink);

    const contentSrc = writeContentSrc('attempt');

    expect(() =>
      handleWriteInPlace({
        type: 'write-in-place',
        targetPath: symlink,
        contentSrc,
        defaultMode: '0644',
      }),
    ).toThrow(/refusing to follow/);
  });
});

// ---------------------------------------------------------------------------
// handleWriteSymlink
// ---------------------------------------------------------------------------

describe('handleWriteSymlink', () => {
  it.skipIf(isWindows)('creates a new symlink with the given target', () => {
    const targetPath = path.join(tmpDir, 'my-link');
    const symlinkTarget = '/tmp/some-target';

    handleWriteSymlink({
      type: 'write-symlink',
      targetPath,
      symlinkTarget,
    });

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(targetPath)).toBe(symlinkTarget);
  });

  it.skipIf(isWindows)('replaces an existing symlink atomically', () => {
    const targetPath = path.join(tmpDir, 'replace-link');
    fs.symlinkSync('/tmp/old-target', targetPath);

    handleWriteSymlink({
      type: 'write-symlink',
      targetPath,
      symlinkTarget: '/tmp/new-target',
    });

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(targetPath)).toBe('/tmp/new-target');
  });

  it.skipIf(isWindows)('refuses to overwrite a real directory', () => {
    const targetPath = path.join(tmpDir, 'real-dir');
    fs.mkdirSync(targetPath);

    expect(() =>
      handleWriteSymlink({
        type: 'write-symlink',
        targetPath,
        symlinkTarget: '/tmp/something',
      }),
    ).toThrow(/directory/);
  });

  it.skipIf(isWindows)(
    'creates a backup of an existing regular file when backupPath is given',
    () => {
      const targetPath = path.join(tmpDir, 'file-to-replace.txt');
      fs.writeFileSync(targetPath, 'original content');
      fs.chmodSync(targetPath, 0o644);

      const backupPath = path.join(
        tmpDir,
        'backups',
        'file-to-replace.txt.bak',
      );

      handleWriteSymlink({
        type: 'write-symlink',
        targetPath,
        symlinkTarget: '/tmp/new-target',
        backupPath,
      });

      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf8')).toBe('original content');
    },
  );

  it.skipIf(isWindows)(
    'creates a backup of an existing symlink as an absolute-target symlink',
    () => {
      const realFile = path.join(tmpDir, 'real.txt');
      fs.writeFileSync(realFile, 'real');
      const targetPath = path.join(tmpDir, 'existing-link');
      // Use a relative symlink so we can verify it gets stored as absolute.
      fs.symlinkSync('real.txt', targetPath);

      const backupPath = path.join(tmpDir, 'backups', 'existing-link.bak');

      handleWriteSymlink({
        type: 'write-symlink',
        targetPath,
        symlinkTarget: '/tmp/other',
        backupPath,
      });

      // Backup should be a symlink.
      expect(fs.lstatSync(backupPath).isSymbolicLink()).toBe(true);
      // Backup target should be absolute (resolved from original location).
      const backupTarget = fs.readlinkSync(backupPath);
      expect(path.isAbsolute(backupTarget)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// handleDelete
// ---------------------------------------------------------------------------

describe('handleDelete', () => {
  it('removes an existing file', () => {
    const targetPath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(targetPath, 'bye');

    handleDelete({ type: 'delete', targetPath });

    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('does NOT throw when the file does not exist (ENOENT)', () => {
    const targetPath = path.join(tmpDir, 'nonexistent.txt');

    expect(() => handleDelete({ type: 'delete', targetPath })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('routes write-mv op to handleWriteMv', () => {
    const targetPath = path.join(tmpDir, 'dispatch-mv.txt');
    const contentSrc = writeContentSrc('dispatched mv');

    dispatch({
      type: 'write-mv',
      targetPath,
      contentSrc,
      defaultMode: '0644',
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('dispatched mv');
  });

  it('routes write-in-place op to handleWriteInPlace', () => {
    const targetPath = path.join(tmpDir, 'dispatch-inplace.txt');
    const contentSrc = writeContentSrc('dispatched inplace');

    dispatch({
      type: 'write-in-place',
      targetPath,
      contentSrc,
      defaultMode: '0644',
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('dispatched inplace');
  });

  it.skipIf(isWindows)('routes write-symlink op to handleWriteSymlink', () => {
    const targetPath = path.join(tmpDir, 'dispatch-link');

    dispatch({
      type: 'write-symlink',
      targetPath,
      symlinkTarget: '/tmp/dispatch-target',
    });

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(targetPath)).toBe('/tmp/dispatch-target');
  });

  it('routes delete op to handleDelete', () => {
    const targetPath = path.join(tmpDir, 'dispatch-delete.txt');
    fs.writeFileSync(targetPath, 'delete me');

    dispatch({ type: 'delete', targetPath });

    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
