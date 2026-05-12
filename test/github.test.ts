import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitHub } from '../src/sources/github';
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

function makeGhAvailable() {
  return makeSpawnResult({ stdout: 'gh version 2.0.0', status: 0 });
}

function makeGhUnavailable() {
  return makeSpawnResult({ error: new Error('ENOENT'), status: null });
}

// Encode base64 as GitHub's API returns it
function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
});

describe('fetchGitHub — network-error fallback to gh', () => {
  it('falls back to gh when fetch throws a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // fetchPathInfo catch: isGhAvailable → gh --version
    // fetchPathInfoViaCli: gh api repos/.../contents/file.txt?ref=main → base64 content
    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: b64('hello github'), status: 0 }),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', 'main');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('hello github');
  });

  it('rethrows non-network TypeError without falling back to gh', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to parse URL'),
    );

    await expect(fetchGitHub('owner/repo', 'file.txt', 'main')).rejects.toThrow(
      'Failed to parse URL',
    );

    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('rethrows network error when gh is not available', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    mockSpawnSync.mockReturnValue(makeGhUnavailable());

    await expect(fetchGitHub('owner/repo', 'file.txt', 'main')).rejects.toThrow(
      'fetch failed',
    );
  });

  it('falls back to gh for $latest ref resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // resolveRef catch (releases): isGhAvailable → gh --version
    // resolveRefViaCli: gh api repos/.../releases/latest --jq .tag_name → 'v2.0'
    //   (resolveRefViaCli also tries tags if releases returns empty; here releases returns a tag)
    // fetchPathInfo catch: isGhAvailable → gh --version
    // fetchPathInfoViaCli: gh api repos/.../contents/file.txt?ref=v2.0 → base64 content
    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'v2.0\n', status: 0 }))
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: b64('latest content'), status: 0 }),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$latest');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'latest content',
    );
  });
});
