import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchLocal,
  isNonLocalSrcString,
  resolveSymlinkSrcPath,
} from '../src/sources/local';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-sources-local-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('fetchLocal — path resolution and traversal', () => {
  it('resolves a relative path against the working directory', () => {
    writeFileSync(join(tmpDir, 'rel.txt'), 'relative');
    const result = fetchLocal('rel.txt', tmpDir);
    expect(result.files.get('rel.txt')?.toString('utf8')).toBe('relative');
  });

  it('reads nested directories recursively with relative keys', () => {
    mkdirSync(join(tmpDir, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(tmpDir, 'dir', 'top.txt'), 'top');
    writeFileSync(join(tmpDir, 'dir', 'sub', 'deep.txt'), 'deep');
    const result = fetchLocal('dir', tmpDir);
    expect(result.files.get('top.txt')?.toString('utf8')).toBe('top');
    expect(result.files.get(join('sub', 'deep.txt'))?.toString('utf8')).toBe(
      'deep',
    );
  });
});

describe('isNonLocalSrcString', () => {
  it.each([
    'http://example.com/a',
    'https://example.com/a',
    'file:///etc/hosts',
    'exec:echo hi',
    'git+ssh://git@host/repo.git//file',
    'git+https://host/repo.git',
    'ssh://host/repo',
    's3://bucket/key',
    'github:owner/repo:file',
    'gitlab:group/project:file',
    'bitbucket:ws/repo:file',
    'raw:content',
    'vault:secret/path',
    'aws_secrets_manager:name',
    'aws_systems_manager_parameter:/name',
  ])('treats %s as non-local', (s) => {
    expect(isNonLocalSrcString(s)).toBe(true);
  });

  it.each(['./file.txt', 'dir/file', '~/file', 'plain'])(
    'treats %s as local',
    (s) => {
      expect(isNonLocalSrcString(s)).toBe(false);
    },
  );
});

describe('resolveSymlinkSrcPath', () => {
  it('throws when a variable expands to a non-local value', () => {
    expect(() =>
      resolveSymlinkSrcPath(
        '$target',
        tmpDir,
        { target: 'https://user:pw@example.com/x' },
        true,
        join(tmpDir, 'link'),
      ),
    ).toThrow(
      'symlink src resolved to a non-local value "https://example.com/x"',
    );
  });

  it('resolves a relative src against the working directory in absolute mode', () => {
    expect(
      resolveSymlinkSrcPath('a/b', tmpDir, {}, 'absolute', join(tmpDir, 'l')),
    ).toBe(join(tmpDir, 'a', 'b'));
  });

  it('keeps an absolute src as-is', () => {
    const abs = join(tmpDir, 'x');
    expect(
      resolveSymlinkSrcPath(abs, tmpDir, {}, true, join(tmpDir, 'l')),
    ).toBe(abs);
  });

  it('returns a path relative to the link directory in relative mode', () => {
    const linkPath = join(tmpDir, 'links', 'l');
    expect(
      resolveSymlinkSrcPath('data/file', tmpDir, {}, 'relative', linkPath),
    ).toBe(relative(dirname(linkPath), join(tmpDir, 'data', 'file')));
  });

  it('returns "." when the src is the link\'s parent directory', () => {
    const linkPath = join(tmpDir, 'l');
    expect(
      resolveSymlinkSrcPath(tmpDir, tmpDir, {}, 'relative', linkPath),
    ).toBe('.');
  });
});
