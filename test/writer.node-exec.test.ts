import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkNodeVersion,
  resolveNodeExec,
  NODE_VERSION_CHECK_TIMEOUT_MS,
} from '../src/writer';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

// Fake filesystem for resolveNodeExec: realpathSync and statSync only know the
// paths in `fakeLinks` / `fakeFiles`; everything else is ENOENT.
const fakeLinks = new Map<string, string>();
const fakeFiles = new Map<string, { uid: number }>();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const enoent = (p: string) =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    ...actual,
    realpathSync: (p: string) => {
      const target = fakeLinks.get(p) ?? (fakeFiles.has(p) ? p : undefined);
      if (target === undefined) throw enoent(p);
      return target;
    },
    statSync: (p: string) => {
      const f = fakeFiles.get(p);
      if (!f) throw enoent(p);
      return { isFile: () => true, mode: 0o755, uid: f.uid };
    },
  };
});

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
  fakeLinks.clear();
  fakeFiles.clear();
  delete process.env.AVANTI_NODE_EXEC;
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

  it('retries and reports a child killed by a signal without output', () => {
    mockSpawnSync.mockReturnValue(result({ status: null, signal: 'SIGKILL' }));
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/killed by SIGKILL/);
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

  it('reports a spawn error without a code by its message', () => {
    mockSpawnSync.mockReturnValue(
      result({ status: null, error: new Error('something broke') }),
    );
    const check = checkNodeVersion('/usr/bin/node');
    expect(!check.ok && check.reason).toMatch(/something broke/);
  });

  it('reports unrecognised output', () => {
    mockSpawnSync.mockReturnValue(result({ stdout: 'garbage\n' }));
    const check = checkNodeVersion('/usr/bin/node');
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/unrecognised version output/);
  });

  it('treats missing stdout as unrecognised output', () => {
    mockSpawnSync.mockReturnValue(
      result({ stdout: null as unknown as string }),
    );
    const check = checkNodeVersion('/usr/bin/node');
    expect(!check.ok && check.reason).toMatch(/unrecognised version output/);
  });
});

// sudo is not used on Windows, and path.join there produces backslash paths
// that the fake filesystem's POSIX keys would not match.
describe.skipIf(process.platform === 'win32')('resolveNodeExec', () => {
  const realExecPath = process.execPath;

  // process.execPath resolves to a root-owned /usr/bin/node outside $HOME.
  beforeEach(() => {
    fakeLinks.set(realExecPath, '/usr/bin/node');
    fakeFiles.set('/usr/bin/node', { uid: 0 });
  });

  afterEach(() => {
    fakeLinks.clear();
    fakeFiles.clear();
  });

  it('returns the process binary when it is root-owned and recent', () => {
    mockSpawnSync.mockReturnValue(result({ stdout: 'v22.0.0\n' }));
    expect(resolveNodeExec('user-exec-ok')).toBe('/usr/bin/node');
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to a SAFE_DIRS binary when the process binary is rejected', () => {
    fakeFiles.set('/usr/local/bin/node', { uid: 0 });
    mockSpawnSync.mockImplementation((cmd) =>
      cmd === '/usr/bin/node'
        ? result({ stdout: 'v16.0.0\n' })
        : result({ stdout: 'v20.0.0\n' }),
    );
    expect(resolveNodeExec('user-fallback')).toBe('/usr/local/bin/node');
  });

  it('probes each real binary once and lists rejected candidates in the error', () => {
    // /usr/bin/nodejs and /bin/node point at the same file as process.execPath.
    fakeLinks.set('/usr/bin/nodejs', '/usr/bin/node');
    fakeLinks.set('/bin/node', '/usr/bin/node');
    // A second, distinct root-owned binary that is too old.
    fakeFiles.set('/usr/local/bin/node', { uid: 0 });
    // A user-owned binary is skipped without being probed.
    fakeFiles.set('/bin/nodejs', { uid: 501 });
    mockSpawnSync.mockImplementation((cmd) =>
      cmd === '/usr/bin/node' ? timedOut() : result({ stdout: 'v16.0.0\n' }),
    );

    let message = '';
    try {
      resolveNodeExec('user-all-rejected');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/No root-owned Node\.js binary/);
    expect(message).toContain(
      `Rejected candidates: /usr/bin/node: version check timed out after ${NODE_VERSION_CHECK_TIMEOUT_MS}ms; ` +
        '/usr/local/bin/node: version v16.0.0 is older than v18.',
    );
    // /usr/bin/node: 2 attempts (timeout + retry), /usr/local/bin/node: 1.
    const calls = mockSpawnSync.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      '/usr/bin/node',
      '/usr/bin/node',
      '/usr/local/bin/node',
    ]);
  });

  it('omits the rejected list when no candidate exists', () => {
    fakeLinks.clear();
    fakeFiles.clear();
    expect(() => resolveNodeExec('user-none')).toThrow(
      /^(?!.*Rejected candidates).*No root-owned Node\.js binary/s,
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
