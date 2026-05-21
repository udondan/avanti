import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitHubRelease } from '../src/sources/github';
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
    statSync: vi.fn(),
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
  ) => SpawnSyncReturns<string>
>;

const mockMkdtempSync = fs.mkdtempSync as unknown as MockInstance;
const mockReaddirSync = fs.readdirSync as unknown as MockInstance;
const mockStatSync = fs.statSync as unknown as MockInstance;
const mockReadFileSync = fs.readFileSync as unknown as MockInstance;
const mockRmSync = fs.rmSync as unknown as MockInstance;

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
  mockMkdtempSync.mockReturnValue('/tmp/avanti-test-gh-rel');
  mockRmSync.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
});

describe('fetchGitHubRelease — CLI fallback', () => {
  it('falls back to CLI when API returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    mockReaddirSync.mockReturnValueOnce(['app.tar.gz']);
    mockStatSync.mockReturnValueOnce({ isFile: () => true });
    mockReadFileSync.mockReturnValueOnce(Buffer.from('binary content'));

    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = await fetchGitHubRelease('owner/repo', 'v1.0.0');
    expect(result.files.get('app.tar.gz')?.toString()).toBe('binary content');
  });

  it('falls back to CLI on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    mockReaddirSync.mockReturnValueOnce(['binary.bin']);
    mockStatSync.mockReturnValueOnce({ isFile: () => true });
    mockReadFileSync.mockReturnValueOnce(Buffer.from('raw bytes'));

    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    const result = await fetchGitHubRelease('owner/repo', 'v1.0.0');
    expect(result.files.get('binary.bin')?.toString()).toBe('raw bytes');
  });

  it('throws when CLI gh release download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    mockSpawnSync
      .mockReturnValueOnce(makeGhAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stderr: 'release not found', status: 1 }),
      );

    await expect(fetchGitHubRelease('owner/repo', 'v1.0.0')).rejects.toThrow(
      'release not found',
    );
  });
});
