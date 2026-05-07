import { describe, it, expect } from 'vitest';
import { resolveTargetPath } from '../src/diff';

describe('resolveTargetPath', () => {
  const wdir = '/project';

  it('resolves relative target relative to workingDir', () => {
    expect(resolveTargetPath({ target: 'out.txt' }, 'ignored', wdir)).toBe(
      '/project/out.txt',
    );
  });

  it('resolves relative directory target with relPath', () => {
    expect(resolveTargetPath({ target: 'scripts/' }, 'foo/bar.sh', wdir)).toBe(
      '/project/scripts/foo/bar.sh',
    );
  });

  it('resolves with no target using relPath', () => {
    expect(resolveTargetPath({}, 'renovate.json', wdir)).toBe(
      '/project/renovate.json',
    );
  });

  it('throws when relative target escapes workingDir via ../', () => {
    expect(() =>
      resolveTargetPath({ target: '../../etc/passwd' }, '', wdir),
    ).toThrow('escapes working directory');
  });

  it('throws on absolute target when workingDir is not /', () => {
    expect(() =>
      resolveTargetPath({ target: '/etc/passwd' }, '', wdir),
    ).toThrow('Absolute target path');
  });

  it('allows absolute target when workingDir is /', () => {
    expect(resolveTargetPath({ target: '/etc/hosts' }, '', '/')).toBe(
      '/etc/hosts',
    );
  });

  it('allows absolute directory target when workingDir is /', () => {
    expect(resolveTargetPath({ target: '/etc/conf/' }, 'my.conf', '/')).toBe(
      '/etc/conf/my.conf',
    );
  });

  it('resolves variables in target', () => {
    expect(
      resolveTargetPath({ target: 'dir/$team/file.json' }, '', wdir, {
        team: 'backend',
      }),
    ).toBe('/project/dir/backend/file.json');
  });

  it('resolves env vars in target', () => {
    process.env['TEST_TEAM'] = 'frontend';
    expect(
      resolveTargetPath({ target: 'dir/$env:TEST_TEAM/file.json' }, '', wdir),
    ).toBe('/project/dir/frontend/file.json');
    delete process.env['TEST_TEAM'];
  });

  it('throws on undefined variable in target', () => {
    expect(() =>
      resolveTargetPath({ target: 'dir/$missing/file.json' }, '', wdir),
    ).toThrow('Undefined variable: $missing');
  });
});
