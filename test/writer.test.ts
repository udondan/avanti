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
});
