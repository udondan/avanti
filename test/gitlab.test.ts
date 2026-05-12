import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitLab } from '../src/sources/gitlab';
import { _testable } from '../src/fetch';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    command: string,
    args: readonly string[],
    options: object,
  ) => SpawnSyncReturns<string | Buffer>
>;

function makeSpawnResult(opts: {
  stdout?: string | Buffer;
  stderr?: string;
  status?: number | null;
  error?: Error;
}): SpawnSyncReturns<string | Buffer> {
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

function makeGlabAvailable() {
  return makeSpawnResult({ stdout: 'glab version 1.0.0', status: 0 });
}

function makeGlabUnavailable() {
  return makeSpawnResult({ error: new Error('ENOENT'), status: null });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
});

describe('fetchGitLab — glab explicit hostname failure', () => {
  it('throws when glab fails with an explicit hostname configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // detectPathType catch: isGlabAvailable → glab --version
    // detectPathTypeViaCli: glabApi --hostname my-host → fails → throws (no silent fallback)
    mockSpawnSync.mockReturnValueOnce(makeGlabAvailable()).mockReturnValueOnce(
      makeSpawnResult({
        stdout: '',
        stderr: 'ERROR Unauthenticated',
        status: 1,
      }),
    );

    await expect(
      fetchGitLab('group/project', 'file.txt', 'main', 'my-host.example.com'),
    ).rejects.toThrow(
      'gitlab: glab failed for group/project: ERROR Unauthenticated',
    );
  });
});

describe('fetchGitLab — network-error fallback to glab', () => {
  it('falls back to glab when fetch throws a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // detectPathType catch: isGlabAvailable → glab --version
    // detectPathTypeViaCli: glab api …/files/file.txt?ref=main → status 0 = 'file'
    // fetchFile catch: isGlabAvailable → glab --version
    // fetchFileViaCli: glab api …/files/file.txt/raw?ref=main → content
    mockSpawnSync
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: '{}', status: 0 }))
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: Buffer.from('hello world'), status: 0 }),
      );

    const result = await fetchGitLab('group/project', 'file.txt', 'main');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('hello world');
  });

  it('rethrows non-network TypeError without falling back to glab', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to parse URL'),
    );

    await expect(
      fetchGitLab('group/project', 'file.txt', 'main'),
    ).rejects.toThrow('Failed to parse URL');

    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('rethrows network error when glab is not available', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    mockSpawnSync.mockReturnValue(makeGlabUnavailable());

    await expect(
      fetchGitLab('group/project', 'file.txt', 'main'),
    ).rejects.toThrow('fetch failed');
  });

  it('falls back to glab for $latest ref resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // resolveRef catch: isGlabAvailable → glab --version
    // resolveRefViaCli: glab api …/tags → returns tag name
    // detectPathType catch: isGlabAvailable → glab --version
    // detectPathTypeViaCli: glab api …/files/…?ref=v1.0 → status 0 = 'file'
    // fetchFile catch: isGlabAvailable → glab --version
    // fetchFileViaCli: glab api …/files/…/raw?ref=v1.0 → content
    mockSpawnSync
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: JSON.stringify([{ name: 'v1.0' }]),
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: '{}', status: 0 }))
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: Buffer.from('tagged content'), status: 0 }),
      );

    const result = await fetchGitLab('group/project', 'file.txt', '$latest');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'tagged content',
    );
  });
});
