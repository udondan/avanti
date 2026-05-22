import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandBraces, expandTilde, resolveFollowSymlink } from '../src/paths';

describe('expandTilde', () => {
  it('expands bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('expands ~/subdir to a subdirectory of home', () => {
    expect(expandTilde('~/subdir')).toBe(path.join(os.homedir(), 'subdir'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandTilde('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path');
  });
});

describe('resolveFollowSymlink', () => {
  const isWindows = process.platform === 'win32';
  let tmpDir: string;

  beforeEach(() => {
    // realpathSync resolves macOS /var → /private/var so the working-dir
    // prefix check in assertWithinWorkingDir matches the realpathSync output.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-paths-test-')),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns targetPath unchanged when followSymlink is false', () => {
    const target = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(target, 'content');
    expect(resolveFollowSymlink(target, { followSymlink: false }, tmpDir)).toBe(
      target,
    );
  });

  it('returns targetPath unchanged when followSymlink is undefined', () => {
    const target = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(target, 'content');
    expect(resolveFollowSymlink(target, {}, tmpDir)).toBe(target);
  });

  it('returns targetPath unchanged when path does not exist', () => {
    const target = path.join(tmpDir, 'nonexistent.txt');
    expect(resolveFollowSymlink(target, { followSymlink: true }, tmpDir)).toBe(
      target,
    );
  });

  it('returns targetPath unchanged when path is a regular file', () => {
    const target = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(target, 'content');
    expect(resolveFollowSymlink(target, { followSymlink: true }, tmpDir)).toBe(
      target,
    );
  });

  it.skipIf(isWindows)(
    'resolves a symlink to the real file path within working dir',
    () => {
      const real = path.join(tmpDir, 'real.txt');
      const link = path.join(tmpDir, 'link.txt');
      fs.writeFileSync(real, 'content');
      fs.symlinkSync(real, link);
      const result = resolveFollowSymlink(
        link,
        { followSymlink: true },
        tmpDir,
      );
      expect(result).toBe(fs.realpathSync(real));
      expect(result).not.toBe(link);
    },
  );

  it.skipIf(isWindows)(
    'throws when symlink resolves to a path outside the working directory',
    () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'avanti-outside-'),
      );
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'secret');
        const link = path.join(tmpDir, 'escape.txt');
        fs.symlinkSync(outsideFile, link);
        expect(() =>
          resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
        ).toThrow(/escapes working directory/);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isWindows)('throws when symlink resolves to a directory', () => {
    const subdir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subdir);
    const link = path.join(tmpDir, 'dirlink');
    fs.symlinkSync(subdir, link);
    expect(() =>
      resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
    ).toThrow(/resolves to a directory/);
  });
});

describe('expandBraces', () => {
  it('returns the pattern unchanged when there are no braces', () => {
    expect(expandBraces('some/path/foo')).toEqual(['some/path/foo']);
  });

  it('expands a single brace group', () => {
    expect(expandBraces('some/path/{foo,bar}')).toEqual([
      'some/path/foo',
      'some/path/bar',
    ]);
  });

  it('leaves a single-alternative brace group (no comma) unexpanded', () => {
    expect(expandBraces('some/{foo}')).toEqual(['some/{foo}']);
  });

  it('expands multiple brace groups', () => {
    expect(expandBraces('{a,b}/{x,y}')).toEqual(['a/x', 'a/y', 'b/x', 'b/y']);
  });

  it('preserves prefix and suffix around the brace group', () => {
    expect(expandBraces('prefix-{one,two}-suffix')).toEqual([
      'prefix-one-suffix',
      'prefix-two-suffix',
    ]);
  });

  it('leaves empty braces unexpanded', () => {
    expect(expandBraces('some/{}')).toEqual(['some/{}']);
  });

  it('expands brace group with extension', () => {
    expect(expandBraces('config/{dev,prod}.yml')).toEqual([
      'config/dev.yml',
      'config/prod.yml',
    ]);
  });
});
