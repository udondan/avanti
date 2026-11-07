// Error and edge paths of the small writer helpers: batched privileged reads
// and stats through a (fake) session, result padding, error normalisation and
// backup staging of non-regular files.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerResult, WriteOp } from '../src/privileged-worker';
import {
  sudoAtomicRead,
  sudoStatBatch,
  type SudoWorkerSession,
} from '../src/writer';
import { createBackups } from '../src/writer/atomic-stage';
import { toError } from '../src/writer/errors';
import { crashSentinel, padResults } from '../src/writer/worker-results';

type ExecFn = (
  ops: WriteOp[],
  continueOnError?: boolean,
  timeoutMs?: number,
) => Promise<WorkerResult[]>;

// A stand-in for SudoWorkerSession: only exec() is used by the batch helpers.
function fakeSession(results: WorkerResult[]): {
  sessions: Map<true | string, SudoWorkerSession>;
  exec: ReturnType<typeof vi.fn<ExecFn>>;
} {
  const exec = vi.fn<ExecFn>(() => Promise.resolve(results));
  const session = { exec } as unknown as SudoWorkerSession;
  return { sessions: new Map([[true, session]]), exec };
}

describe('sudoAtomicRead through a session', () => {
  it('returns an empty map without calling the session for no reads', async () => {
    const { sessions, exec } = fakeSession([]);
    expect((await sudoAtomicRead([], sessions)).size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes a batch timeout to the session and maps the results', async () => {
    const { sessions, exec } = fakeSession([
      { ok: true, contentB64: 'aGk=', isSymlink: false },
      { ok: false, code: 'ENOENT', error: 'missing' },
      { ok: true },
    ]);
    const result = await sudoAtomicRead(
      [
        { filePath: 'a.txt', sudo: true },
        { filePath: 'b.txt', sudo: true, type: 'stat-read' },
        { filePath: 'c.txt', sudo: true },
      ],
      sessions,
    );
    expect(result.get('a.txt')).toEqual({
      contentB64: 'aGk=',
      isSymlink: false,
    });
    // Absent file and an ok result without content both map to null.
    expect(result.get('b.txt')).toBeNull();
    expect(result.get('c.txt')).toBeNull();
    const [ops, continueOnError, timeoutMs] = exec.mock.calls[0];
    expect(ops.map((o) => o.type)).toEqual(['read', 'stat-read', 'read']);
    expect(ops[0].targetPath).toBe(path.resolve('a.txt'));
    expect(continueOnError).toBe(true);
    expect(timeoutMs).toBe(30_000);
  });

  it('throws for an unexpected read error', async () => {
    const { sessions } = fakeSession([
      { ok: false, code: 'EFBIG', error: 'file too large' },
    ]);
    await expect(
      sudoAtomicRead([{ filePath: 'big.bin', sudo: true }], sessions),
    ).rejects.toThrow('privileged read of big.bin failed: file too large');
  });

  it('throws when the reader crashed after completing all ops', async () => {
    const { sessions } = fakeSession([
      { ok: true, contentB64: 'eA==' },
      { ok: false, error: 'exited non-zero (1)' },
    ]);
    await expect(
      sudoAtomicRead([{ filePath: 'x', sudo: true }], sessions),
    ).rejects.toThrow(
      'privileged reader crashed after completing all ops: exited non-zero (1)',
    );
  });

  it('reports an unknown crash reason when the sentinel has no error', async () => {
    const { sessions } = fakeSession([{ ok: true }, { ok: false }]);
    await expect(
      sudoAtomicRead([{ filePath: 'x', sudo: true }], sessions),
    ).rejects.toThrow(
      'privileged reader crashed after completing all ops: unknown',
    );
  });
});

describe('sudoStatBatch through a session', () => {
  it('returns an empty map without calling the session for no targets', async () => {
    const { sessions, exec } = fakeSession([]);
    expect((await sudoStatBatch([], sessions)).size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('maps every expected stat-read outcome', async () => {
    const { sessions, exec } = fakeSession([
      { ok: true, mode: '0644', contentB64: 'Zg==' },
      { ok: true, isSymlink: true, contentB64: 'L3Q=', mode: '0777' },
      { ok: false, code: 'EISDIR', error: 'is a directory' },
      { ok: false, code: 'ENOTREGFILE', error: 'special file' },
      { ok: false, code: 'ENOENT', error: 'missing' },
      { ok: false, code: 'EACCES', error: 'denied', mode: '0600' },
      { ok: false, code: 'EPERM', error: 'not permitted' },
    ]);
    const names = ['file', 'link', 'dir', 'fifo', 'gone', 'denied', 'eperm'];
    const result = await sudoStatBatch(
      names.map((filePath) => ({ filePath, sudo: true })),
      sessions,
    );
    expect(result.get('file')).toEqual({
      exists: true,
      isSymlink: false,
      isDirectory: false,
      isSpecialFile: false,
      mode: '0644',
      contentB64: 'Zg==',
    });
    expect(result.get('link')).toMatchObject({
      exists: true,
      isSymlink: true,
      contentB64: 'L3Q=',
    });
    expect(result.get('dir')).toMatchObject({
      exists: true,
      isDirectory: true,
      isSpecialFile: false,
      isSymlink: false,
    });
    expect(result.get('fifo')).toMatchObject({
      exists: true,
      isDirectory: false,
      isSpecialFile: true,
    });
    expect(result.get('gone')).toMatchObject({
      exists: false,
      isDirectory: false,
      isSpecialFile: false,
    });
    expect(result.get('denied')).toEqual({
      exists: false,
      isSymlink: false,
      isDirectory: false,
      isSpecialFile: false,
      mode: '0600',
      contentB64: undefined,
    });
    expect(result.get('eperm')).toMatchObject({ exists: false });
    const [ops, continueOnError, timeoutMs] = exec.mock.calls[0];
    expect(ops.every((o) => o.type === 'stat-read')).toBe(true);
    expect(ops[0].targetPath).toBe(path.resolve('file'));
    expect(continueOnError).toBe(true);
    // 7 ops × 2 s is below the 30 s floor.
    expect(timeoutMs).toBe(30_000);
  });

  it('treats a missing result as an absent path', async () => {
    const { sessions } = fakeSession([]);
    const result = await sudoStatBatch(
      [{ filePath: 'never-ran', sudo: true }],
      sessions,
    );
    expect(result.get('never-ran')).toEqual({
      exists: false,
      isSymlink: false,
      isDirectory: false,
      isSpecialFile: false,
      mode: undefined,
      contentB64: undefined,
    });
  });

  it('scales the timeout with the batch size', async () => {
    const targets = Array.from({ length: 20 }, (_, i) => ({
      filePath: `f${i}`,
      sudo: true as const,
    }));
    const { sessions, exec } = fakeSession(targets.map(() => ({ ok: true })));
    await sudoStatBatch(targets, sessions);
    expect(exec.mock.calls[0][2]).toBe(40_000);
  });

  it('throws for an unexpected stat-read error code', async () => {
    const { sessions } = fakeSession([
      { ok: false, code: 'EIO', error: 'i/o error' },
    ]);
    await expect(
      sudoStatBatch([{ filePath: 'bad', sudo: true }], sessions),
    ).rejects.toThrow('stat-read failed for bad: i/o error');
  });

  it('falls back to the code, then a generic text, in the stat-read error', async () => {
    const { sessions: byCode } = fakeSession([{ ok: false, code: 'ESTALE' }]);
    await expect(
      sudoStatBatch([{ filePath: 'p', sudo: true }], byCode),
    ).rejects.toThrow('stat-read failed for p: ESTALE');
    const { sessions: bare } = fakeSession([{ ok: false }]);
    await expect(
      sudoStatBatch([{ filePath: 'p', sudo: true }], bare),
    ).rejects.toThrow('stat-read failed for p: unknown error');
  });

  it('throws when the stat-reader crashed after completing all ops', async () => {
    const { sessions } = fakeSession([
      { ok: true },
      { ok: false, error: 'signal SIGKILL' },
    ]);
    await expect(
      sudoStatBatch([{ filePath: 'p', sudo: true }], sessions),
    ).rejects.toThrow(
      'privileged stat-reader crashed after completing all ops: signal SIGKILL',
    );
    const { sessions: bare } = fakeSession([{ ok: true }, { ok: false }]);
    await expect(
      sudoStatBatch([{ filePath: 'p', sudo: true }], bare),
    ).rejects.toThrow(
      'privileged stat-reader crashed after completing all ops: unknown',
    );
  });

  it('groups targets by sudo identity and requires a session for each', async () => {
    const { sessions, exec } = fakeSession([{ ok: true }]);
    await expect(
      sudoStatBatch(
        [
          { filePath: 'root-owned', sudo: true },
          { filePath: 'www-owned', sudo: 'www-data' },
        ],
        sessions,
      ),
    ).rejects.toThrow(
      'no privileged session for sudo identity "www-data"; ensure openPrivilegedSessions is called before sudoStatBatch',
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('worker result helpers', () => {
  it('pads missing results with a not-processed failure', () => {
    expect(padResults([{ ok: true }], 3)).toEqual([
      { ok: true },
      { ok: false, error: 'worker exited before processing this op' },
      { ok: false, error: 'worker exited before processing this op' },
    ]);
  });

  it('clamps surplus results to the op count', () => {
    expect(padResults([{ ok: true }, { ok: false }], 1)).toEqual([
      { ok: true },
    ]);
  });

  it('only reports a failed surplus entry as a crash sentinel', () => {
    expect(crashSentinel([{ ok: true }, { ok: true }], 1)).toBeUndefined();
    expect(crashSentinel([{ ok: true }], 1)).toBeUndefined();
    expect(crashSentinel([{ ok: true }, { ok: false, error: 'e' }], 1)).toEqual(
      { ok: false, error: 'e' },
    );
  });
});

describe('toError', () => {
  it('returns an Error unchanged', () => {
    const err = new Error('boom');
    expect(toError(err)).toBe(err);
  });

  it('wraps a non-Error value', () => {
    const err = toError('plain string');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('plain string');
    expect(toError(42).message).toBe('42');
  });
});

describe('createBackups', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-backups-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips a target that is neither a regular file nor a symlink', () => {
    const dirTarget = path.join(tmpDir, 'a-directory');
    fs.mkdirSync(dirTarget);
    const backupPath = path.join(tmpDir, 'backups', 'a-directory.bak');
    const backupTemps: string[] = [];
    createBackups(
      [{ targetPath: dirTarget, content: Buffer.from('x'), backupPath }],
      backupTemps,
    );
    expect(backupTemps).toEqual([]);
    // Nothing was staged, so not even the backup directory exists.
    expect(fs.existsSync(path.dirname(backupPath))).toBe(false);
  });

  it('backs up a regular file next to the backup path', () => {
    const target = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(target, 'original');
    const backupPath = path.join(tmpDir, 'backups', 'file.txt.bak');
    const backupTemps: string[] = [];
    createBackups(
      [{ targetPath: target, content: Buffer.from('new'), backupPath }],
      backupTemps,
    );
    expect(backupTemps).toHaveLength(1);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('original');
  });
});
