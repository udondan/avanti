import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkNodeVersion, NODE_VERSION_CHECK_TIMEOUT_MS } from '../src/writer';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
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

function result(
  overrides: Partial<SpawnSyncReturns<string>>,
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

function timedOut(): SpawnSyncReturns<string> {
  const error = Object.assign(new Error('spawnSync node ETIMEDOUT'), {
    code: 'ETIMEDOUT',
  });
  return result({ status: null, signal: 'SIGTERM', error });
}

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe('checkNodeVersion', () => {
  it('accepts a supported version', () => {
    mockSpawnSync.mockReturnValue(result({ stdout: 'v22.1.0\n' }));
    expect(checkNodeVersion('/usr/bin/node')).toEqual({ ok: true, major: 22 });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['--version'],
      expect.objectContaining({ timeout: NODE_VERSION_CHECK_TIMEOUT_MS }),
    );
  });

  it('uses a timeout long enough for a loaded machine', () => {
    expect(NODE_VERSION_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('retries once after a timeout', () => {
    mockSpawnSync
      .mockReturnValueOnce(timedOut())
      .mockReturnValueOnce(result({ stdout: 'v20.0.0\n' }));
    expect(checkNodeVersion('/usr/bin/node')).toEqual({ ok: true, major: 20 });
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout when both attempts time out', () => {
    mockSpawnSync.mockReturnValue(timedOut());
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/timed out/);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('rejects a version older than v18', () => {
    mockSpawnSync.mockReturnValue(result({ stdout: 'v16.20.2\n' }));
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/v16\.20\.2.*older than v18/);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports a spawn error with its code', () => {
    const error = Object.assign(new Error('spawnSync EACCES'), {
      code: 'EACCES',
    });
    mockSpawnSync.mockReturnValue(result({ status: null, error }));
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/EACCES/);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports unrecognised output', () => {
    mockSpawnSync.mockReturnValue(result({ stdout: 'garbage\n' }));
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/unrecognised version output/);
  });
});
