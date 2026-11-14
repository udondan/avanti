// Error paths of the one-shot (spawnSync) privileged worker invocation. sudo is
// never really run: spawnSync is mocked and returns canned worker responses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { runPrivilegedWorker } from '../src/writer/run-worker';
import type { WriteOp } from '../src/privileged-worker';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    opts: object,
  ) => SpawnSyncReturns<string>
>;

function spawnResult(
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

function respond(overrides: Partial<SpawnSyncReturns<string>>): void {
  mockSpawnSync.mockReturnValue(spawnResult(overrides));
}

const ops = (n: number): WriteOp[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'delete' as const,
    targetPath: `/etc/avanti-test-${i}`,
  }));

const body = (results: unknown): string => JSON.stringify({ results });

const isWindows = process.platform === 'win32';
const originalPlatform = process.platform;

beforeEach(() => {
  mockSpawnSync.mockReset();
  // Skip the root-owned node scan; the binary is never executed here.
  process.env.AVANTI_NODE_EXEC = process.execPath;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.AVANTI_NODE_EXEC;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('runPrivilegedWorker on Windows', () => {
  it('refuses to run', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'sudo is not supported on Windows',
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe.skipIf(isWindows)('runPrivilegedWorker error handling', () => {
  it('explains a stdout maxBuffer overflow', () => {
    const error = Object.assign(new Error('spawnSync sudo ENOBUFS'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    respond({ error, status: null });
    let thrown: unknown;
    try {
      runPrivilegedWorker(true, ops(1));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/exceeded the 150 MiB maxBuffer/);
    expect((thrown as Error).cause).toBe(error);
  });

  it('rethrows any other spawn error unchanged', () => {
    const error = Object.assign(new Error('spawnSync sudo ENOENT'), {
      code: 'ENOENT',
    });
    respond({ error, status: null });
    expect(() => runPrivilegedWorker('www-data', ops(1))).toThrow(error);
  });

  it('throws the error of the first failed op without continueOnError', () => {
    respond({ stdout: body([{ ok: true }, { ok: false, error: 'EROFS' }]) });
    expect(() => runPrivilegedWorker(true, ops(2))).toThrow('EROFS');
  });

  it('uses a generic message for a failed op without an error text', () => {
    respond({ stdout: body([{ ok: false }]) });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker op failed',
    );
  });

  it('returns failed ops without throwing when continueOnError is set', () => {
    respond({ stdout: body([{ ok: false, error: 'EROFS' }]) });
    expect(runPrivilegedWorker(true, ops(1), true)).toEqual([
      { ok: false, error: 'EROFS' },
    ]);
  });

  it('rejects an exit 0 without any output', () => {
    respond({ stdout: '' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker exited 0 but wrote no output',
    );
  });

  it('rejects a response without a results array', () => {
    respond({ stdout: '{"oops":true}' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker returned malformed response (missing results array): {"oops":true}',
    );
    respond({ stdout: 'null' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'malformed response (missing results array): null',
    );
  });

  it('reports a result count mismatch', () => {
    respond({ stdout: body([{ ok: true }]) });
    expect(() => runPrivilegedWorker(true, ops(2))).toThrow(
      'privileged worker returned 1 results, expected 2',
    );
  });

  it('prefers the failed op error over the count mismatch', () => {
    respond({ stdout: body([{ ok: false, error: 'ENOSPC' }]) });
    expect(() => runPrivilegedWorker(true, ops(3), true)).toThrow('ENOSPC');
  });

  it('wraps non-JSON output', () => {
    respond({ stdout: 'Segmentation fault' });
    let thrown: unknown;
    try {
      runPrivilegedWorker(true, ops(1));
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe(
      'privileged worker returned non-JSON output: Segmentation fault',
    );
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('pads partial results and appends a crash sentinel on a non-zero exit', () => {
    respond({ status: 1, stdout: body([{ ok: true }]) });
    expect(runPrivilegedWorker(true, ops(3), true)).toEqual([
      { ok: true },
      { ok: false, error: 'worker exited before processing this op' },
      { ok: false, error: 'worker exited before processing this op' },
      {
        ok: false,
        error: 'privileged worker exited non-zero (1) after completing all ops',
      },
    ]);
  });

  it('describes a signal in the crash sentinel', () => {
    respond({ status: null, signal: 'SIGKILL', stdout: body([{ ok: true }]) });
    const results = runPrivilegedWorker(true, ops(1), true);
    expect(results.at(-1)).toEqual({
      ok: false,
      error:
        'privileged worker exited non-zero (signal SIGKILL) after completing all ops',
    });
  });

  it('throws the generic exit message when continueOnError has no output', () => {
    respond({ status: 3, stdout: '' });
    expect(() => runPrivilegedWorker(true, ops(1), true)).toThrow(
      'privileged worker failed (exit 3)',
    );
  });

  it('throws when the partial output holds no results', () => {
    respond({ status: 2, stdout: body([]) });
    expect(() => runPrivilegedWorker(true, ops(1), true)).toThrow(
      'privileged worker failed (exit 2)',
    );
    respond({ status: 2, stdout: 'not json' });
    expect(() => runPrivilegedWorker(true, ops(1), true)).toThrow(
      'privileged worker failed (exit 2)',
    );
  });

  it('names the terminating signal when the worker was killed', () => {
    respond({ status: null, signal: 'SIGTERM', stdout: '' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker terminated by signal SIGTERM',
    );
  });

  it('surfaces the failed op error from the output of a non-zero exit', () => {
    respond({
      status: 1,
      stdout: body([{ ok: true }, { ok: false, error: 'EACCES: denied' }]),
    });
    expect(() => runPrivilegedWorker(true, ops(2))).toThrow('EACCES: denied');
  });

  it('keeps the exit message when the output has no usable error', () => {
    respond({ status: 1, stdout: body([{ ok: false }]) });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker failed (exit 1)',
    );
    respond({ status: 1, stdout: '{}' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker failed (exit 1)',
    );
    respond({ status: 1, stdout: '{garbage' });
    expect(() => runPrivilegedWorker(true, ops(1))).toThrow(
      'privileged worker failed (exit 1)',
    );
  });
});
