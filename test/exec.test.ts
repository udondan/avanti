import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchExec } from '../src/sources/exec';

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
  ) => SpawnSyncReturns<Buffer>
>;

function makeSpawnResult(opts: {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number | null;
  error?: Error;
}): SpawnSyncReturns<Buffer> {
  return {
    stdout: Buffer.isBuffer(opts.stdout)
      ? opts.stdout
      : Buffer.from(opts.stdout ?? ''),
    stderr: Buffer.isBuffer(opts.stderr)
      ? opts.stderr
      : Buffer.from(opts.stderr ?? ''),
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

describe('fetchExec', () => {
  it('returns stdout as a Buffer on success', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: 'hello world' }));

    const result = fetchExec('echo hello world');

    expect(result.toString('utf8')).toBe('hello world');
  });

  it('throws when the command exits with non-zero status and no stderr', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ status: 1 }));

    expect(() => fetchExec('false')).toThrow('exec exited with code 1');
  });

  it('includes stderr in the error message on non-zero exit', () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ status: 127, stderr: 'command not found: badcmd' }),
    );

    expect(() => fetchExec('badcmd')).toThrow(
      'exec exited with code 127: command not found: badcmd',
    );
  });

  it('throws when spawnSync itself fails to launch the process', () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ error: new Error('ENOENT'), status: null }),
    );

    expect(() => fetchExec('nonexistent-tool')).toThrow(
      'exec failed to spawn: ENOENT',
    );
  });

  it('returns binary content as a Buffer', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: binary }));

    const result = fetchExec('some-binary-command');

    expect(result).toEqual(binary);
  });

  it('returns an empty Buffer when stdout is absent', () => {
    mockSpawnSync.mockReturnValue({
      stdout: null as unknown as Buffer,
      stderr: Buffer.alloc(0),
      status: 0,
      pid: 0,
      output: [],
      signal: null,
    });

    const result = fetchExec('silent-command');

    expect(result).toEqual(Buffer.alloc(0));
  });
});
