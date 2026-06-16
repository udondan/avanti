import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitLabRelease } from '../src/sources/gitlab';
import { _testable } from '../src/fetch';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdtempSync: vi.fn(),
    openSync: vi.fn(),
    closeSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import type { MockInstance } from 'vitest';

const mockMkdtempSync = fs.mkdtempSync as unknown as MockInstance;
const mockReadFileSync = fs.readFileSync as unknown as MockInstance;

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

function makeReleaseMetaJson(opts: {
  name?: string;
  url?: string;
  direct_asset_url?: string;
  link_type?: string;
}) {
  return JSON.stringify({
    assets: {
      links: [
        {
          name: opts.name ?? 'artifact.tar.gz',
          url:
            opts.url ??
            'https://git.example.com//-/project/1/uploads/abc/artifact.tar.gz',
          ...(opts.direct_asset_url !== undefined
            ? { direct_asset_url: opts.direct_asset_url }
            : {}),
          link_type: opts.link_type ?? 'package',
        },
      ],
    },
  });
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

describe('fetchGitLabRelease — CLI fallback', () => {
  it('falls back to CLI when API returns 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('artifact bytes', { status: 200 }));

    mockSpawnSync.mockReturnValueOnce(makeGlabAvailable()).mockReturnValueOnce(
      makeSpawnResult({
        status: 0,
        stdout: makeReleaseMetaJson({
          name: 'artifact.tar.gz',
          direct_asset_url:
            'https://git.example.com/group/project/-/releases/v1.0.0/downloads/artifact.tar.gz',
        }),
      }),
    );

    const result = await fetchGitLabRelease('group/project', 'v1.0.0');
    expect(result.files.get('artifact.tar.gz')?.toString()).toBe(
      'artifact bytes',
    );
  });

  it('falls back to CLI on network error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('zip bytes', { status: 200 }));

    mockSpawnSync.mockReturnValueOnce(makeGlabAvailable()).mockReturnValueOnce(
      makeSpawnResult({
        status: 0,
        stdout: makeReleaseMetaJson({
          name: 'pkg.zip',
          direct_asset_url:
            'https://git.example.com/group/project/-/releases/v1.0.0/downloads/pkg.zip',
        }),
      }),
    );

    const result = await fetchGitLabRelease('group/project', 'v1.0.0');
    expect(result.files.get('pkg.zip')?.toString()).toBe('zip bytes');
  });
});

describe('fetchGitLabRelease — CLI path (via: cli)', () => {
  it('uses direct_asset_url when present instead of buggy url', async () => {
    const directUrl =
      'https://git.example.com/group/project/-/releases/v1.0.0/downloads/artifact.tar.gz';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('file content', { status: 200 }),
    );

    mockSpawnSync.mockReturnValueOnce(
      makeSpawnResult({
        status: 0,
        stdout: makeReleaseMetaJson({
          url: 'https://git.example.com//-/project/1/uploads/abc/artifact.tar.gz',
          direct_asset_url: directUrl,
        }),
      }),
    );

    const result = await fetchGitLabRelease(
      'group/project',
      'v1.0.0',
      undefined,
      'cli',
    );
    expect(result.files.get('artifact.tar.gz')?.toString()).toBe(
      'file content',
    );

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(fetchCalls[0][0]).toBe(directUrl);
    expect(fetchCalls[0][0]).not.toContain(
      'https://git.example.com//-/project/',
    );
  });

  it('falls back to link.url when direct_asset_url is absent', async () => {
    const linkUrl =
      'https://git.example.com/group/project/-/releases/v1.0.0/downloads/artifact.tar.gz';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('file content', { status: 200 }),
    );

    mockSpawnSync.mockReturnValueOnce(
      makeSpawnResult({
        status: 0,
        stdout: makeReleaseMetaJson({ url: linkUrl }),
      }),
    );

    const result = await fetchGitLabRelease(
      'group/project',
      'v1.0.0',
      undefined,
      'cli',
    );
    expect(result.files.get('artifact.tar.gz')?.toString()).toBe(
      'file content',
    );

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(fetchCalls[0][0]).toBe(linkUrl);
  });

  it('passes --hostname to both glab calls when no env-var token is present', async () => {
    const directUrl =
      'https://git.example.com/group/project/-/releases/v1.0.0/downloads/artifact.tar.gz';

    // When host matches gitlabHost and no GITLAB_TOKEN is set, glabApiBinaryToFile
    // is used for the download (to avoid GitLab returning a 200 HTML sign-in page
    // to an unauthenticated fetch). Set up the fs and spawnSync mocks for it.
    mockMkdtempSync.mockReturnValueOnce('/tmp/fake-avanti-glab');
    mockReadFileSync.mockReturnValueOnce(Buffer.from('data'));

    mockSpawnSync
      .mockReturnValueOnce(
        makeSpawnResult({
          status: 0,
          stdout: makeReleaseMetaJson({ direct_asset_url: directUrl }),
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = await fetchGitLabRelease(
      'group/project',
      'v1.0.0',
      'git.example.com',
      'cli',
    );
    expect(result.files.get('artifact.tar.gz')?.toString()).toBe('data');

    const calls = mockSpawnSync.mock.calls;
    // Metadata: glab api --hostname git.example.com projects/...
    expect(calls[0][1]).toContain('--hostname');
    expect(calls[0][1]).toContain('git.example.com');
    // Download: glab api --hostname git.example.com <direct URL> (via glabApiBinaryToFile)
    expect(calls[1][1]).toContain('--hostname');
    expect(calls[1][1]).toContain('git.example.com');
    expect(calls[1][1]).toContain(directUrl);
  });
});
