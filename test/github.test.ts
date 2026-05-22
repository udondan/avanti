import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitHub, fetchGitHubRelease } from '../src/sources/github';
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

describe('fetchGitHub — via option', () => {
  it('via: cli skips API and calls gh directly', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected API call'));

    // fetchPathInfo → fetchPathInfoViaCli: gh → base64 content
    mockSpawnSync.mockReturnValueOnce(
      makeSpawnResult({ stdout: b64('cli content'), status: 0 }),
    );

    const result = await fetchGitHub(
      'owner/repo',
      'file.txt',
      'main',
      undefined,
      'cli',
    );
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('cli content');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('via: api throws on network error without falling back to gh', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    await expect(
      fetchGitHub('owner/repo', 'file.txt', 'main', undefined, 'api'),
    ).rejects.toThrow('fetch failed');

    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('via: [cli, api] tries gh first, falls back to API on CLI error', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: 'file', content: b64('api content') }),
          { status: 200 },
        ),
      );

    // fetchPathInfo → fetchPathInfoViaCli: gh fails
    // falls back to API: returns file content
    mockSpawnSync.mockReturnValueOnce(
      makeSpawnResult({ stdout: '', stderr: 'gh error', status: 1 }),
    );

    const result = await fetchGitHub(
      'owner/repo',
      'file.txt',
      'main',
      undefined,
      ['cli', 'api'],
    );
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('api content');
    expect(fetchSpy).toHaveBeenCalled();
  });
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

    // resolveRef network error → isGhAvailable → resolveRefViaCli('$latest')
    //   resolveRefViaCli: releases/latest → 'v2.0.0' (semver, accepted)
    // fetchPathInfo network error → isGhAvailable → fetchPathInfoViaCli
    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'v2.0.0\n', status: 0 }))
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: b64('latest content'), status: 0 }),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$latest');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'latest content',
    );
  });

  it('falls back to gh for $recent ref resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    // resolveRef network error → isGhAvailable → resolveRefViaCli('$recent')
    //   resolveRefViaCli: releases/latest → 'nightly' (accepted as-is for $recent)
    // fetchPathInfo network error → isGhAvailable → fetchPathInfoViaCli
    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'nightly\n', status: 0 }))
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: b64('recent content'), status: 0 }),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$recent');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'recent content',
    );
  });
});

describe('fetchGitHub — ref sentinels and pattern', () => {
  it('$latest resolves via releases/latest when tag is semver', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // resolveRef: releases/latest → v1.2.3 (semver ✓)
        new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        // fetchPathInfo
        new Response(
          JSON.stringify({ type: 'file', content: b64('semver content') }),
          { status: 200 },
        ),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$latest');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'semver content',
    );
  });

  it('$latest skips non-semver release tag and searches tags', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // releases/latest → 'nightly' (not semver)
        new Response(JSON.stringify({ tag_name: 'nightly' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        // tags page 1 → v1.2.3 (semver ✓)
        new Response(
          JSON.stringify([{ name: 'v1.2.3' }, { name: 'nightly' }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        // fetchPathInfo
        new Response(
          JSON.stringify({ type: 'file', content: b64('stable content') }),
          { status: 200 },
        ),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$latest');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'stable content',
    );
  });

  it('$recent accepts any tag including non-semver', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // releases/latest → 'nightly' (accepted as-is for $recent)
        new Response(JSON.stringify({ tag_name: 'nightly' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        // fetchPathInfo
        new Response(
          JSON.stringify({ type: 'file', content: b64('nightly content') }),
          { status: 200 },
        ),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '$recent');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe(
      'nightly content',
    );
  });

  it('pattern /^v1\\./ resolves to first matching tag', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // tags page 1 — v2.0.0 doesn't match, v1.9.0 does
        new Response(JSON.stringify([{ name: 'v2.0.0' }, { name: 'v1.9.0' }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        // fetchPathInfo
        new Response(
          JSON.stringify({ type: 'file', content: b64('v1 content') }),
          { status: 200 },
        ),
      );

    const result = await fetchGitHub('owner/repo', 'file.txt', '/^v1\\./');
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('v1 content');
  });

  it('throws when pattern matches no tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ name: 'v2.0.0' }]), { status: 200 }),
      ),
    );
    // gh is unavailable so the CLI fallback is not attempted
    mockSpawnSync.mockReturnValue(makeGhUnavailable());

    await expect(
      fetchGitHub('owner/repo', 'file.txt', '/^v99\\./'),
    ).rejects.toThrow('No tags matching "/^v99\\./" found for owner/repo');
  });
});

describe('fetchGitHubRelease', () => {
  it('fetches all assets for a specific tag via API', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            assets: [
              { id: 1, name: 'app.tar.gz' },
              { id: 2, name: 'checksums.txt' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('binary data'), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('sha256 ...'), { status: 200 }),
      );

    const result = await fetchGitHubRelease('owner/repo', 'v1.0.0');
    expect(result.files.size).toBe(2);
    expect(result.files.get('app.tar.gz')?.toString()).toBe('binary data');
    expect(result.files.get('checksums.txt')?.toString()).toBe('sha256 ...');
  });

  it('resolves $latest before fetching assets', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'v2.0.0' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ assets: [{ id: 10, name: 'release.zip' }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('zip content'), { status: 200 }),
      );

    const result = await fetchGitHubRelease('owner/repo', '$latest');
    expect(result.files.get('release.zip')?.toString()).toBe('zip content');
  });

  it('throws when release has no assets', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ assets: [] }), { status: 200 }),
    );

    await expect(fetchGitHubRelease('owner/repo', 'v1.0.0')).rejects.toThrow(
      'No release assets found for owner/repo@v1.0.0',
    );
  });

  // CLI fallback tests live in test/github-release-cli.test.ts (need vi.mock('fs'))
});
