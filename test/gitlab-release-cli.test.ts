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
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    command: string,
    args: readonly string[],
    options: object,
  ) => SpawnSyncReturns<string | Buffer>
>;

const mockMkdtempSync = fs.mkdtempSync as unknown as MockInstance;
const mockReaddirSync = fs.readdirSync as unknown as MockInstance;
const mockReadFileSync = fs.readFileSync as unknown as MockInstance;
const mockRmSync = fs.rmSync as unknown as MockInstance;

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
  mockMkdtempSync.mockReturnValue('/tmp/avanti-test-gl-rel');
  mockRmSync.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
});

describe('fetchGitLabRelease — CLI fallback', () => {
  it('falls back to CLI when API returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    mockReaddirSync.mockReturnValueOnce([
      { name: 'artifact.tar.gz', isDirectory: () => false, isFile: () => true },
    ]);
    mockReadFileSync.mockReturnValueOnce(Buffer.from('artifact bytes'));

    mockSpawnSync
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = await fetchGitLabRelease('group/project', 'v1.0.0');
    expect(result.files.get('artifact.tar.gz')?.toString()).toBe(
      'artifact bytes',
    );
  });

  it('falls back to CLI on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    mockReaddirSync.mockReturnValueOnce([
      { name: 'pkg.zip', isDirectory: () => false, isFile: () => true },
    ]);
    mockReadFileSync.mockReturnValueOnce(Buffer.from('zip bytes'));

    mockSpawnSync
      .mockReturnValueOnce(makeGlabAvailable())
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = await fetchGitLabRelease('group/project', 'v1.0.0');
    expect(result.files.get('pkg.zip')?.toString()).toBe('zip bytes');
  });
});
