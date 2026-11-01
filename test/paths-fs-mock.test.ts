import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Some resolveFollowSymlink branches depend on filesystem states a real
// filesystem cannot produce reliably (a dangling chain that realpath reports
// as missing but that loops, or a missing filesystem root). Simulate them.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
    readlinkSync: vi.fn(),
  };
});

import * as fs from 'fs';
import { resolveFollowSymlink } from '../src/paths';

const lstat = vi.mocked(fs.lstatSync);
const realpath = vi.mocked(fs.realpathSync);
const readlink = vi.mocked(fs.readlinkSync);

const symlinkStat = {
  isSymbolicLink: () => true,
  isDirectory: () => false,
} as fs.Stats;

const wd = path.resolve('/avanti-mock-wd');
const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

function mockLinks(links: Record<string, string>): void {
  realpath.mockImplementation(((p: string) => {
    if (p === wd) return wd;
    throw enoent;
  }) as typeof fs.realpathSync);
  lstat.mockImplementation(((p: string) =>
    p in links ? symlinkStat : undefined) as typeof fs.lstatSync);
  readlink.mockImplementation(
    ((p: string) => links[p]) as typeof fs.readlinkSync,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('resolveFollowSymlink — simulated filesystem states', () => {
  it('detects a cycle in a chain that realpath reports as missing', () => {
    const a = path.join(wd, 'a');
    const b = path.join(wd, 'b');
    mockLinks({ [a]: 'b', [b]: 'a' });
    expect(() => resolveFollowSymlink(a, { followSymlink: true }, wd)).toThrow(
      `followSymlink: "${a}" contains a circular symlink`,
    );
  });

  it('rejects an endpoint outside workingDir when no ancestor exists', () => {
    const link = path.join(wd, 'link');
    const outside = path.resolve('/avanti-mock-elsewhere/x/y');
    mockLinks({ [link]: outside });
    expect(() =>
      resolveFollowSymlink(link, { followSymlink: true }, wd),
    ).toThrow(/escapes the working directory$/);
  });
});
