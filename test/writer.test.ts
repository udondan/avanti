import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('atomicWrite', () => {
  it('writes a single file with correct content', () => {
    const dest = path.join(tmpDir, 'output.txt');
    atomicWrite([{ targetPath: dest, content: 'hello world' }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello world');
  });

  it('creates parent directories if they do not exist', () => {
    const dest = path.join(tmpDir, 'nested', 'dir', 'output.txt');
    atomicWrite([{ targetPath: dest, content: 'nested content' }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('nested content');
  });

  it('writes multiple files atomically', () => {
    const dest1 = path.join(tmpDir, 'file1.txt');
    const dest2 = path.join(tmpDir, 'file2.txt');
    atomicWrite([
      { targetPath: dest1, content: 'content one' },
      { targetPath: dest2, content: 'content two' },
    ]);
    expect(fs.readFileSync(dest1, 'utf8')).toBe('content one');
    expect(fs.readFileSync(dest2, 'utf8')).toBe('content two');
  });

  it('applies mode (file permissions) when specified', () => {
    const dest = path.join(tmpDir, 'script.sh');
    atomicWrite([
      { targetPath: dest, content: '#!/bin/sh\necho hi', mode: '0755' },
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

  it('cleans up the temp dir after successful write', () => {
    const before = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith('avanti-')).length;
    const dest = path.join(tmpDir, 'clean.txt');
    atomicWrite([{ targetPath: dest, content: 'ok' }]);
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith('avanti-')).length;
    // No new avanti- temp dirs should have been left behind
    expect(after).toBeLessThanOrEqual(before);
  });

  it('overwrites existing file content', () => {
    const dest = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(dest, 'old content', 'utf8');
    atomicWrite([{ targetPath: dest, content: 'new content' }]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new content');
  });

  it('preserves existing file permission bits when no mode is specified', () => {
    const dest = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(dest, 'original', 'utf8');
    fs.chmodSync(dest, 0o600);
    atomicWrite([{ targetPath: dest, content: 'updated' }]);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });
});
