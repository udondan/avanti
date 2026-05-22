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

// Detect whether this process can create symlinks at runtime.
// On Windows without SeCreateSymbolicLinkPrivilege, symlinkSync throws EPERM.
const canCreateSymlinks = (() => {
  let tmp: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-symtest-'));
    const link = path.join(tmp, 'link');
    fs.symlinkSync(tmp, link);
    return true;
  } catch {
    return false;
  } finally {
    if (tmp !== undefined) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
})();

describe('resolveFollowSymlink', () => {
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

  it.skipIf(!canCreateSymlinks)(
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

  it.skipIf(!canCreateSymlinks)(
    'resolves a dangling symlink (target does not exist yet) within working dir',
    () => {
      const link = path.join(tmpDir, 'link.txt');
      const nonexistentTarget = path.join(tmpDir, 'will-be-created.txt');
      fs.symlinkSync(nonexistentTarget, link);
      // Target doesn't exist — realpathSync would throw, but we should succeed
      const result = resolveFollowSymlink(
        link,
        { followSymlink: true },
        tmpDir,
      );
      expect(result).toBe(nonexistentTarget);
    },
  );

  it.skipIf(!canCreateSymlinks)(
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

  it.skipIf(!canCreateSymlinks)(
    'throws when symlink resolves to a directory',
    () => {
      const subdir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(subdir);
      const link = path.join(tmpDir, 'dirlink');
      fs.symlinkSync(subdir, link);
      expect(() =>
        resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
      ).toThrow(/resolves to a directory/);
    },
  );

  it.skipIf(!canCreateSymlinks)(
    'throws when symlink-to-directory is reached through a symlink chain',
    () => {
      // link.txt -> intermediate -> subdir (directory)
      // Verifies that the directory check happens after full canonicalization.
      const subdir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(subdir);
      const intermediate = path.join(tmpDir, 'intermediate');
      fs.symlinkSync(subdir, intermediate);
      const link = path.join(tmpDir, 'link.txt');
      fs.symlinkSync(intermediate, link);
      expect(() =>
        resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
      ).toThrow(/resolves to a directory/);
    },
  );

  it.skipIf(!canCreateSymlinks)(
    'resolves a dangling symlink chain (A -> B -> nonexistent) within working dir',
    () => {
      const link2 = path.join(tmpDir, 'link2.txt');
      const nonexistentTarget = path.join(tmpDir, 'will-be-created.txt');
      fs.symlinkSync(nonexistentTarget, link2);
      const link = path.join(tmpDir, 'link.txt');
      fs.symlinkSync(link2, link);
      const result = resolveFollowSymlink(
        link,
        { followSymlink: true },
        tmpDir,
      );
      expect(result).toBe(nonexistentTarget);
    },
  );

  it.skipIf(!canCreateSymlinks)(
    'throws when a dangling symlink chain contains a cycle',
    () => {
      // link.txt -> link2.txt -> link.txt (cycle, final target never exists)
      // realpathSync throws ELOOP for fully-existing cycles, but manual
      // traversal handles cycles where the chain also involves missing targets.
      const link = path.join(tmpDir, 'link.txt');
      const link2 = path.join(tmpDir, 'link2.txt');
      fs.symlinkSync(link2, link);
      fs.symlinkSync(link, link2);
      expect(() =>
        resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
      ).toThrow(/circular symlink/);
    },
  );

  it.skipIf(!canCreateSymlinks)(
    'throws when a dangling symlink escapes via an intermediate symlinked directory',
    () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'avanti-outside-'),
      );
      try {
        // workingDir/out -> outsideDir (symlink to a directory outside working dir)
        const outLink = path.join(tmpDir, 'out');
        fs.symlinkSync(outsideDir, outLink);
        // link.txt -> workingDir/out/secret.txt (dangling, but out/ escapes)
        const link = path.join(tmpDir, 'link.txt');
        fs.symlinkSync(path.join(tmpDir, 'out', 'secret.txt'), link);
        expect(() =>
          resolveFollowSymlink(link, { followSymlink: true }, tmpDir),
        ).toThrow(/escapes working directory/);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canCreateSymlinks)(
    'resolves a dangling symlink when workingDir is itself a symlinked directory',
    () => {
      // Exercises the macOS /var → /private/var alias pattern: workingDir is a
      // non-canonical symlink path but the target is still inside the real tree.
      const symlinkWorkingDir = path.join(
        os.tmpdir(),
        `avanti-wdlink-${process.pid}`,
      );
      fs.symlinkSync(tmpDir, symlinkWorkingDir);
      try {
        const link = path.join(symlinkWorkingDir, 'link.txt');
        const nonexistentTarget = path.join(
          symlinkWorkingDir,
          'will-be-created.txt',
        );
        fs.symlinkSync(nonexistentTarget, link);
        // workingDir is the symlink path — resolveFollowSymlink must not falsely
        // throw "escapes working directory" for a valid in-tree dangling symlink.
        const result = resolveFollowSymlink(
          link,
          { followSymlink: true },
          symlinkWorkingDir,
        );
        expect(result).toBe(path.join(tmpDir, 'will-be-created.txt'));
      } finally {
        fs.rmSync(symlinkWorkingDir);
      }
    },
  );
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
