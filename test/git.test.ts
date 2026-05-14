import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  fetchGit,
  isGitRemoteUrl,
  parseGitRemoteSpec,
} from '../src/sources/git';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => SpawnSyncReturns<string>
>;

function makeSpawnResult(opts: {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: Error;
}): SpawnSyncReturns<string> {
  return {
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    status: opts.status ?? 0,
    pid: 0,
    output: [],
    signal: null,
    error: opts.error,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isGitRemoteUrl ────────────────────────────────────────────────────────────

describe('isGitRemoteUrl', () => {
  it('recognizes git+ssh:// URLs', () => {
    expect(isGitRemoteUrl('git+ssh://git@host/org/repo.git//file.txt')).toBe(
      true,
    );
  });

  it('recognizes git:// URLs', () => {
    expect(isGitRemoteUrl('git://host/repo.git//file.txt')).toBe(true);
  });

  it('recognizes ssh:// URLs', () => {
    expect(isGitRemoteUrl('ssh://git@host/repo.git//file.txt')).toBe(true);
  });

  it('rejects https:// URLs', () => {
    expect(isGitRemoteUrl('https://github.com/owner/repo')).toBe(false);
  });

  it('rejects plain file paths', () => {
    expect(isGitRemoteUrl('/path/to/file')).toBe(false);
  });
});

// ── parseGitRemoteSpec ────────────────────────────────────────────────────────

describe('parseGitRemoteSpec', () => {
  it('parses a full spec with ref', () => {
    expect(
      parseGitRemoteSpec(
        'git+ssh://git@host/org/repo.git//path/to/file.yml@main',
      ),
    ).toEqual({
      repo: 'git+ssh://git@host/org/repo.git',
      file: 'path/to/file.yml',
      ref: 'main',
    });
  });

  it('parses a spec without ref', () => {
    expect(
      parseGitRemoteSpec('git+ssh://git@host/org/repo.git//avanti.yml'),
    ).toEqual({
      repo: 'git+ssh://git@host/org/repo.git',
      file: 'avanti.yml',
      ref: undefined,
    });
  });

  it('parses a git:// spec with ref', () => {
    const result = parseGitRemoteSpec('git://host/repo.git//config.yml@v1.0');
    expect(result.repo).toBe('git://host/repo.git');
    expect(result.file).toBe('config.yml');
    expect(result.ref).toBe('v1.0');
  });

  it('parses a directory path', () => {
    const result = parseGitRemoteSpec(
      'git+ssh://git@host/repo.git//src/processors@main',
    );
    expect(result.file).toBe('src/processors');
    expect(result.ref).toBe('main');
  });

  it('throws on a non-git URL', () => {
    expect(() => parseGitRemoteSpec('https://github.com/owner/repo')).toThrow(
      'Invalid git URL spec',
    );
  });

  it('throws when no // separator is present', () => {
    expect(() => parseGitRemoteSpec('git+ssh://git@host/repo.git')).toThrow(
      'Invalid git URL spec',
    );
  });

  it('throws when file path is empty after //', () => {
    expect(() => parseGitRemoteSpec('git+ssh://git@host/repo.git//')).toThrow(
      'File path is required',
    );
  });
});

// ── fetchGit — clone error handling ──────────────────────────────────────────

describe('fetchGit — clone failures', () => {
  it('throws when git clone exits with non-zero status', () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ status: 128, stderr: 'fatal: repository not found' }),
    );

    expect(() =>
      fetchGit('https://example.com/repo.git', 'file.txt', 'main'),
    ).toThrow('git clone failed: fatal: repository not found');
  });

  it('throws when git clone fails to spawn (e.g. git not installed)', () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ error: new Error('ENOENT'), status: null }),
    );

    expect(() =>
      fetchGit('https://example.com/repo.git', 'file.txt', 'main'),
    ).toThrow('git error: ENOENT');
  });

  it('throws when git checkout fails for a commit hash ref', () => {
    const hash = 'a'.repeat(40);
    mockSpawnSync
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }))
      .mockReturnValueOnce(
        makeSpawnResult({ status: 1, stderr: 'error: pathspec not found' }),
      );

    expect(() =>
      fetchGit('https://example.com/repo.git', 'file.txt', hash),
    ).toThrow(`git checkout ${hash} failed`);
  });
});

// ── fetchGit — success paths ──────────────────────────────────────────────────

describe('fetchGit — success paths', () => {
  it('clones and returns a single file', () => {
    mockSpawnSync.mockImplementation((_cmd, args) => {
      const repoDir = String(args[args.length - 1]);
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'world');
      return makeSpawnResult({ status: 0 });
    });

    const result = fetchGit(
      'https://example.com/repo.git',
      'hello.txt',
      'main',
    );

    expect(result.files.size).toBe(1);
    expect(result.files.get('hello.txt')?.toString('utf8')).toBe('world');
  });

  it('clones and returns all files from a directory', () => {
    mockSpawnSync.mockImplementation((_cmd, args) => {
      const repoDir = String(args[args.length - 1]);
      const dir = path.join(repoDir, 'src');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export {}');
      fs.writeFileSync(path.join(dir, 'b.ts'), 'export {}');
      return makeSpawnResult({ status: 0 });
    });

    const result = fetchGit('https://example.com/repo.git', 'src/', 'main');

    expect(result.files.size).toBe(2);
    expect(result.files.has('a.ts')).toBe(true);
    expect(result.files.has('b.ts')).toBe(true);
  });

  it('throws when the requested path does not exist in the clone', () => {
    mockSpawnSync.mockImplementation((_cmd, args) => {
      const repoDir = String(args[args.length - 1]);
      fs.mkdirSync(repoDir, { recursive: true });
      return makeSpawnResult({ status: 0 });
    });

    expect(() =>
      fetchGit('https://example.com/repo.git', 'missing.txt', 'main'),
    ).toThrow('Path not found in repository');
  });

  it('does a full clone + checkout for a 40-character commit hash', () => {
    const hash = 'b'.repeat(40);

    mockSpawnSync
      .mockImplementationOnce((_cmd, args) => {
        const repoDir = String(args[args.length - 1]);
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'pinned.txt'), 'pinned');
        return makeSpawnResult({ status: 0 });
      })
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = fetchGit('https://example.com/repo.git', 'pinned.txt', hash);

    expect(result.files.get('pinned.txt')?.toString('utf8')).toBe('pinned');
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    const checkoutArgs = mockSpawnSync.mock.calls[1][1] as string[];
    expect(checkoutArgs).toContain(hash);
  });
});
