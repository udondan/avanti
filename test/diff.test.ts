import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { resolveTargetPath } from '../src/diff';

// Platform-agnostic working directory and root for tests.
// os.tmpdir() is a valid absolute path on every OS.
const wdir = path.join(os.tmpdir(), 'avanti-test-project');
const root = path.parse(wdir).root;

describe('resolveTargetPath', () => {
  it('resolves relative target relative to workingDir', () => {
    expect(resolveTargetPath({ target: 'out.txt' }, 'ignored', wdir)).toBe(
      path.join(wdir, 'out.txt'),
    );
  });

  it('resolves relative directory target with relPath', () => {
    expect(resolveTargetPath({ target: 'scripts/' }, 'foo/bar.sh', wdir)).toBe(
      path.join(wdir, 'scripts', 'foo', 'bar.sh'),
    );
  });

  it('resolves with no target using relPath', () => {
    expect(resolveTargetPath({}, 'renovate.json', wdir)).toBe(
      path.join(wdir, 'renovate.json'),
    );
  });

  it('throws when relative target escapes workingDir via ../', () => {
    expect(() =>
      resolveTargetPath({ target: '../../etc/passwd' }, '', wdir),
    ).toThrow('escapes working directory');
  });

  it('throws on absolute target when workingDir is not root', () => {
    const absTarget = path.join(root, 'etc', 'passwd');
    expect(() => resolveTargetPath({ target: absTarget }, '', wdir)).toThrow(
      'Absolute target path',
    );
  });

  it('allows absolute target when workingDir is root', () => {
    const absTarget = path.join(root, 'etc', 'hosts');
    expect(resolveTargetPath({ target: absTarget }, '', root)).toBe(absTarget);
  });

  it('allows absolute directory target when workingDir is root', () => {
    const absDir = path.join(root, 'etc', 'conf') + path.sep;
    expect(resolveTargetPath({ target: absDir }, 'my.conf', root)).toBe(
      path.join(root, 'etc', 'conf', 'my.conf'),
    );
  });

  it('resolves variables in target', () => {
    expect(
      resolveTargetPath({ target: 'dir/$team/file.json' }, '', wdir, {
        team: 'backend',
      }),
    ).toBe(path.join(wdir, 'dir', 'backend', 'file.json'));
  });

  it('resolves env vars in target', () => {
    const prior = process.env['TEST_TEAM'];
    process.env['TEST_TEAM'] = 'frontend';
    try {
      expect(
        resolveTargetPath({ target: 'dir/$env:TEST_TEAM/file.json' }, '', wdir),
      ).toBe(path.join(wdir, 'dir', 'frontend', 'file.json'));
    } finally {
      if (prior === undefined) delete process.env['TEST_TEAM'];
      else process.env['TEST_TEAM'] = prior;
    }
  });

  it('throws on undefined variable in target', () => {
    expect(() =>
      resolveTargetPath({ target: 'dir/$missing/file.json' }, '', wdir),
    ).toThrow('Undefined variable: $missing');
  });

  it('expands ~/ target to home directory', () => {
    expect(
      resolveTargetPath({ target: '~/.opencode/AGENTS.md' }, 'ignored', wdir),
    ).toBe(path.join(os.homedir(), '.opencode', 'AGENTS.md'));
  });

  it('expands ~/ directory target with relPath', () => {
    expect(
      resolveTargetPath({ target: '~/.config/avanti/' }, 'foo.yml', wdir),
    ).toBe(path.join(os.homedir(), '.config', 'avanti', 'foo.yml'));
  });
});
