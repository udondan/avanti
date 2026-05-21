import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const isWindows = process.platform === 'win32';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWrite } from '../src/writer';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-writer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('atomicWrite', () => {
  it('writes a single file with correct content', () => {
    const dest = path.join(tmpDir, 'output.txt');
    atomicWrite([{ targetPath: dest, content: buf('hello world') }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello world');
  });

  it('creates parent directories if they do not exist', () => {
    const dest = path.join(tmpDir, 'nested', 'dir', 'output.txt');
    atomicWrite([{ targetPath: dest, content: buf('nested content') }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('nested content');
  });

  it('writes multiple files atomically', () => {
    const dest1 = path.join(tmpDir, 'file1.txt');
    const dest2 = path.join(tmpDir, 'file2.txt');
    atomicWrite([
      { targetPath: dest1, content: buf('content one') },
      { targetPath: dest2, content: buf('content two') },
    ]);
    expect(fs.readFileSync(dest1, 'utf8')).toBe('content one');
    expect(fs.readFileSync(dest2, 'utf8')).toBe('content two');
  });

  it.skipIf(isWindows)('applies mode (file permissions) when specified', () => {
    const dest = path.join(tmpDir, 'script.sh');
    atomicWrite([
      { targetPath: dest, content: buf('#!/bin/sh\necho hi'), mode: '0755' },
    ]);
    const stat = fs.statSync(dest);
    // Check executable bits are set (mode & 0o111 != 0)
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('deletes files listed in the deletions array', () => {
    const toDelete = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(toDelete, 'remove me', 'utf8');
    expect(fs.existsSync(toDelete)).toBe(true);

    atomicWrite([], [toDelete]);

    expect(fs.existsSync(toDelete)).toBe(false);
  });

  it('does NOT throw if a deletion target does not exist', () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist.txt');
    expect(() => atomicWrite([], [nonExistent])).not.toThrow();
  });

  it('cleans up the temp file after successful write', () => {
    const dest = path.join(tmpDir, 'clean.txt');
    const tmpFile = path.join(tmpDir, '.clean.txt.avanti-tmp');
    atomicWrite([{ targetPath: dest, content: buf('ok') }]);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('overwrites existing file content', () => {
    const dest = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(dest, 'old content', 'utf8');
    atomicWrite([{ targetPath: dest, content: buf('new content') }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new content');
  });

  it.skipIf(isWindows)(
    'preserves existing file permission bits when no mode is specified',
    () => {
      const dest = path.join(tmpDir, 'secret.txt');
      fs.writeFileSync(dest, 'original', 'utf8');
      fs.chmodSync(dest, 0o600);
      atomicWrite([{ targetPath: dest, content: buf('updated') }]);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    },
  );

  it('writes binary content correctly', () => {
    const dest = path.join(tmpDir, 'image.bin');
    // A buffer with null bytes (binary)
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
    atomicWrite([{ targetPath: dest, content: binary }]);
    expect(fs.readFileSync(dest)).toEqual(binary);
  });

  describe('backup', () => {
    it('copies the existing file to backupPath before writing new content', () => {
      const dest = path.join(tmpDir, 'config.yaml');
      const backup = path.join(tmpDir, 'config.yaml.bkp');
      fs.writeFileSync(dest, 'old content', 'utf8');

      atomicWrite([
        { targetPath: dest, content: buf('new content'), backupPath: backup },
      ]);

      expect(fs.readFileSync(backup, 'utf8')).toBe('old content');
      expect(fs.readFileSync(dest, 'utf8')).toBe('new content');
    });

    it('creates the backup directory recursively if it does not exist', () => {
      const dest = path.join(tmpDir, 'file.txt');
      const backup = path.join(tmpDir, 'bkp', 'nested', 'file.txt.bkp');
      fs.writeFileSync(dest, 'original', 'utf8');

      atomicWrite([
        { targetPath: dest, content: buf('updated'), backupPath: backup },
      ]);

      expect(fs.readFileSync(backup, 'utf8')).toBe('original');
    });

    it('does not create a backup when the target file does not yet exist', () => {
      const dest = path.join(tmpDir, 'new.txt');
      const backup = path.join(tmpDir, 'new.txt.bkp');

      atomicWrite([
        { targetPath: dest, content: buf('first write'), backupPath: backup },
      ]);

      expect(fs.existsSync(backup)).toBe(false);
      expect(fs.readFileSync(dest, 'utf8')).toBe('first write');
    });

    it('overwrites an existing backup file', () => {
      const dest = path.join(tmpDir, 'data.txt');
      const backup = path.join(tmpDir, 'data.txt.bkp');
      fs.writeFileSync(dest, 'v2', 'utf8');
      fs.writeFileSync(backup, 'v1', 'utf8');

      atomicWrite([
        { targetPath: dest, content: buf('v3'), backupPath: backup },
      ]);

      expect(fs.readFileSync(backup, 'utf8')).toBe('v2');
      expect(fs.readFileSync(dest, 'utf8')).toBe('v3');
    });

    it('writes normally when no backupPath is set', () => {
      const dest = path.join(tmpDir, 'plain.txt');
      fs.writeFileSync(dest, 'old', 'utf8');

      atomicWrite([{ targetPath: dest, content: buf('new') }]);

      expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    });

    it.skipIf(isWindows)(
      'replaces a symlink at backupPath rather than following it',
      () => {
        const dest = path.join(tmpDir, 'source.txt');
        const outside = path.join(tmpDir, 'outside.txt');
        const backup = path.join(tmpDir, 'source.txt.bkp');
        fs.writeFileSync(dest, 'old content', 'utf8');
        fs.writeFileSync(outside, 'should not be touched', 'utf8');
        fs.symlinkSync(outside, backup);

        atomicWrite([
          { targetPath: dest, content: buf('new content'), backupPath: backup },
        ]);

        // The symlink must be replaced — outside.txt must not be modified.
        expect(fs.readFileSync(outside, 'utf8')).toBe('should not be touched');
        // The backup path must now be a regular file containing the old content.
        expect(fs.lstatSync(backup).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(backup, 'utf8')).toBe('old content');
        expect(fs.readFileSync(dest, 'utf8')).toBe('new content');
      },
    );
  });
});

describe('writeInPlace', () => {
  it('writes correct content', () => {
    const dest = path.join(tmpDir, 'output.txt');
    atomicWrite([
      { targetPath: dest, content: buf('hello'), writeInPlace: true },
    ]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
  });

  it.skipIf(isWindows)('preserves the inode of an existing file', () => {
    const dest = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(dest, 'old', 'utf8');
    const inodeBefore = fs.statSync(dest).ino;
    atomicWrite([
      { targetPath: dest, content: buf('new'), writeInPlace: true },
    ]);
    expect(fs.statSync(dest).ino).toBe(inodeBefore);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it.skipIf(isWindows)('default (mv) mode changes the inode', () => {
    const dest = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(dest, 'old', 'utf8');
    const inodeBefore = fs.statSync(dest).ino;
    atomicWrite([{ targetPath: dest, content: buf('new') }]);
    expect(fs.statSync(dest).ino).not.toBe(inodeBefore);
  });

  it('creates a new file when the target does not exist', () => {
    const dest = path.join(tmpDir, 'new.txt');
    atomicWrite([
      { targetPath: dest, content: buf('created'), writeInPlace: true },
    ]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('created');
  });

  it('creates parent directories if they do not exist', () => {
    const dest = path.join(tmpDir, 'nested', 'dir', 'output.txt');
    atomicWrite([
      { targetPath: dest, content: buf('deep'), writeInPlace: true },
    ]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('deep');
  });

  it('takes a backup of the old content before writing', () => {
    const dest = path.join(tmpDir, 'config.yaml');
    const backup = path.join(tmpDir, 'config.yaml.bkp');
    fs.writeFileSync(dest, 'old content', 'utf8');
    atomicWrite([
      {
        targetPath: dest,
        content: buf('new content'),
        backupPath: backup,
        writeInPlace: true,
      },
    ]);
    expect(fs.readFileSync(backup, 'utf8')).toBe('old content');
    expect(fs.readFileSync(dest, 'utf8')).toBe('new content');
  });

  it.skipIf(isWindows)(
    'preserves existing file permissions when no mode is specified',
    () => {
      const dest = path.join(tmpDir, 'secret.txt');
      fs.writeFileSync(dest, 'original', 'utf8');
      fs.chmodSync(dest, 0o600);
      atomicWrite([
        { targetPath: dest, content: buf('updated'), writeInPlace: true },
      ]);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(isWindows)('applies an explicit mode after writing', () => {
    const dest = path.join(tmpDir, 'script.sh');
    fs.writeFileSync(dest, 'old', 'utf8');
    atomicWrite([
      {
        targetPath: dest,
        content: buf('new'),
        mode: '0755',
        writeInPlace: true,
      },
    ]);
    expect(fs.statSync(dest).mode & 0o111).not.toBe(0);
  });

  it('does not create a temp file', () => {
    const dest = path.join(tmpDir, 'output.txt');
    const tmpFile = path.join(tmpDir, '.output.txt.avanti-tmp');
    atomicWrite([
      { targetPath: dest, content: buf('data'), writeInPlace: true },
    ]);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });
});
