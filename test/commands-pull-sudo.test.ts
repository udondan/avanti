// Covers the privileged (sudo) paths of `avanti pull` without real sudo: the
// writer's privileged entry points are replaced by fakes that operate on the
// test's temp dir as the current user. Unreadable targets are simulated with
// chmod 000 files and non-searchable (0600) parent directories.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullCommand } from '../src/commands/pull';
import { HistoryManager, PullLogFileRef } from '../src/history';
import { computeContentSha256 } from '../src/sha';
import {
  atomicWrite,
  AtomicWritePartialError,
  openPrivilegedSessions,
  sudoAtomicRead,
  sudoAtomicWrite,
  sudoStatBatch,
  SudoWorkerSession,
  SudoWritePartialError,
} from '../src/writer';
import {
  makeTempEnv,
  runCommand,
  TempEnv,
  throwNonError,
} from './commands-pull-helpers';

vi.mock('../src/prompt', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/writer')>();
  return {
    ...actual,
    atomicWrite: vi.fn(actual.atomicWrite),
    openPrivilegedSessions: vi.fn(),
    sudoAtomicRead: vi.fn(),
    sudoAtomicWrite: vi.fn(),
    sudoStatBatch: vi.fn(),
  };
});

const mockOpen = vi.mocked(openPrivilegedSessions);
const mockRead = vi.mocked(sudoAtomicRead);
const mockWrite = vi.mocked(sudoAtomicWrite);
const mockStat = vi.mocked(sudoStatBatch);
const mockAtomicWrite = vi.mocked(atomicWrite);

// chmod-based unreadability does not apply to root, and sudo is POSIX-only.
const isRoot = process.getuid?.() === 0;
const suite = describe.skipIf(process.platform === 'win32' || isRoot);

type ExecResult = Array<{ ok: boolean; skipped?: boolean; error?: string }>;

interface FakeSession {
  exec: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let env: TempEnv;
let sessions: FakeSession[];
let execImpl: (ops: Array<{ targetPath: string }>) => ExecResult;

function pull(...extra: string[]) {
  return runCommand(pullCommand(), [
    '--config',
    env.configPath,
    '--working-dir',
    env.work,
    'pull',
    '--yes',
    ...extra,
  ]);
}

function p(rel: string): string {
  return path.join(env.work, rel);
}

function w(rel: string, content: string): string {
  const file = p(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function statOf(
  over: Partial<{
    exists: boolean;
    isSymlink: boolean;
    isDirectory: boolean;
    isSpecialFile: boolean;
    mode: string;
  }>,
) {
  return {
    exists: true,
    isSymlink: false,
    isDirectory: false,
    isSpecialFile: false,
    ...over,
  };
}

/** Config with one sudo entry. */
function sudoEntry(target: string, extra = '', content = 'x'): string {
  return `  ${target}:
    src:
      - raw: ${content}
    sudo: true
${extra}`;
}

function history(): HistoryManager {
  return new HistoryManager(env.configPath, env.work);
}

beforeEach(() => {
  env = makeTempEnv('pull-sudo');
  sessions = [];
  execImpl = (ops) => {
    for (const op of ops) fs.rmSync(op.targetPath, { force: true });
    return ops.map(() => ({ ok: true }));
  };
  mockOpen.mockReset().mockImplementation((ids) => {
    const map = new Map<true | string, SudoWorkerSession>();
    for (const id of ids) {
      const s: FakeSession = {
        exec: vi.fn((ops: Array<{ targetPath: string }>) =>
          Promise.resolve().then(() => execImpl(ops)),
        ),
        close: vi.fn(),
      };
      sessions.push(s);
      map.set(id, s as unknown as SudoWorkerSession);
    }
    return map;
  });
  mockRead
    .mockReset()
    .mockImplementation((reads) =>
      Promise.resolve(new Map(reads.map((r) => [r.filePath, null]))),
    );
  mockStat.mockReset().mockResolvedValue(new Map());
  mockWrite.mockReset().mockImplementation((targets, chmods = []) => {
    for (const t of targets) {
      fs.chmodSync(path.dirname(t.targetPath), 0o755);
      fs.rmSync(t.targetPath, { force: true });
      if (t.symlinkTarget !== undefined) {
        fs.symlinkSync(t.symlinkTarget, t.targetPath);
      } else {
        fs.writeFileSync(t.targetPath, t.content);
      }
    }
    for (const c of chmods) {
      fs.chmodSync(path.dirname(c.targetPath), 0o755);
      fs.chmodSync(c.targetPath, parseInt(c.mode, 8));
    }
    return Promise.resolve(chmods.length);
  });
});

afterEach(async () => {
  env.cleanup();
  vi.restoreAllMocks();
  const actual =
    await vi.importActual<typeof import('../src/writer')>('../src/writer');
  mockAtomicWrite.mockReset().mockImplementation(actual.atomicWrite);
});

suite('pull: sudo writes', () => {
  it('writes a new file through the privileged session', async () => {
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    const res = await pull();
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(fs.readFileSync(p('out.txt'), 'utf8')).toBe('x');
    expect(res.stdout).toContain('Wrote 1 file(s).');
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect([...mockOpen.mock.calls[0][0]]).toEqual([true]);
    expect(sessions[0].close).toHaveBeenCalled();
    expect(history().getFileMeta(p('out.txt'))?.sudo).toBe(true);
  });

  it('applies a mode-only change through the privileged session', async () => {
    w('out.txt', 'x');
    fs.chmodSync(p('out.txt'), 0o644);
    env.writeConfig(`files:\n${sudoEntry('out.txt', '    mode: "0600"\n')}`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(mockWrite.mock.calls[0][0]).toEqual([]);
    expect(mockWrite.mock.calls[0][1]).toEqual([
      { targetPath: p('out.txt'), mode: '0600', sudo: true },
    ]);
    expect(fs.statSync(p('out.txt')).mode & 0o777).toBe(0o600);
    expect(res.stdout).toContain('Wrote 1 file(s).');
  });

  it('exits 2 when the privileged session cannot be opened', async () => {
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockOpen.mockImplementation(() => {
      throw new Error('sudo: a password is required');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('sudo: a password is required');
  });

  it('reports a session failure that is not an Error', async () => {
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockOpen.mockImplementation(() => {
      throwNonError('sudo unavailable');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('sudo unavailable');
  });
});

suite('pull: unreadable sudo targets', () => {
  function unreadable(content: string): string {
    const file = w('out.txt', content);
    fs.chmodSync(file, 0o000);
    return file;
  }

  it('skips the write when the privileged read matches', async () => {
    const file = unreadable('x');
    const log = p('hooks.log');
    env.writeConfig(
      `files:\n${sudoEntry('out.txt', `    on:\n      update: echo update >> ${log}\n`)}`,
    );
    mockRead.mockResolvedValue(new Map([[file, { contentB64: b64('x') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(mockRead.mock.calls[0][0]).toEqual([
      { filePath: file, sudo: true, type: 'stat-read' },
    ]);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('turns a matching unreadable file with mode drift into a chmod', async () => {
    const file = unreadable('x');
    env.writeConfig(`files:\n${sudoEntry('out.txt', '    mode: "0644"\n')}`);
    mockRead.mockResolvedValue(new Map([[file, { contentB64: b64('x') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(mockWrite.mock.calls[0][1]).toEqual([
      { targetPath: file, mode: '0644', sudo: true },
    ]);
    expect(res.stdout).toContain('Wrote 1 file(s).');
  });

  it('captures v0 from the privileged read before overwriting', async () => {
    const file = unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockRead.mockResolvedValue(new Map([[file, { contentB64: b64('orig') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    expect(history().readVersion(file, 0)?.toString()).toBe('orig');
  });

  it('warns when the privileged worker cannot read the original', async () => {
    unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('cannot capture original content');
    expect(fs.readFileSync(p('out.txt'), 'utf8')).toBe('x');
  });

  it('does not capture v0 through a symlink at a regular-file target', async () => {
    const file = unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockRead.mockResolvedValue(
      new Map([[file, { contentB64: b64('/etc/x'), isSymlink: true }]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    expect(history().readVersion(file, 0)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
  });

  it('throws when a pre-read result is missing', async () => {
    unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockRead.mockResolvedValue(new Map());
    const res = await pull();
    expect(String(res.thrown)).toContain('internal: missing pre-read result');
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it('exits 2 when the privileged read fails', async () => {
    unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockRead.mockRejectedValue(new Error('boom'));
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Read failed: boom');
  });

  it('reports a read failure that is not an Error', async () => {
    unreadable('orig');
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    mockRead.mockRejectedValue('boom');
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Read failed: boom');
  });
});

suite('pull: sudo targets behind a non-searchable directory', () => {
  let target: string;
  beforeEach(() => {
    fs.mkdirSync(p('locked'));
    target = p('locked/out.txt');
  });
  function lock(): void {
    fs.chmodSync(p('locked'), 0o600);
  }

  it('skips special files', async () => {
    env.writeConfig(`files:\n${sudoEntry('locked/out.txt')}`);
    lock();
    mockStat.mockResolvedValue(
      new Map([[target, statOf({ isSpecialFile: true })]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('is a special file');
    expect(res.stdout).toContain('Nothing to do.');
    expect(mockStat.mock.calls[0][0]).toEqual([
      { filePath: target, sudo: true },
    ]);
  });

  it('creates a file the stat-read reports as missing', async () => {
    const log = p('hooks.log');
    env.writeConfig(
      `files:\n${sudoEntry('locked/out.txt', `    on:\n      create: echo create-$AVANTI_IS_NEW >> ${log}\n`)}`,
    );
    lock();
    mockStat.mockResolvedValue(new Map([[target, statOf({ exists: false })]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
    expect(fs.readFileSync(log, 'utf8')).toBe('create-true\n');
  });

  it('treats a missing stat-read result as a new file', async () => {
    env.writeConfig(`files:\n${sudoEntry('locked/out.txt')}`);
    lock();
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('creates a symlink the stat-read reports as missing', async () => {
    w('real.txt', 'real');
    env.writeConfig(`files:
  locked/link:
    src: ./real.txt
    symlink: true
    sudo: true
`);
    lock();
    mockStat.mockResolvedValue(
      new Map([[p('locked/link'), statOf({ exists: false })]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readlinkSync(p('locked/link'))).toBe(p('real.txt'));
  });

  it('detects mode drift from the stat-read', async () => {
    w('locked/out.txt', 'x');
    env.writeConfig(
      `files:\n${sudoEntry('locked/out.txt', '    mode: "0600"\n')}`,
    );
    lock();
    mockStat.mockResolvedValue(new Map([[target, statOf({ mode: '0644' })]]));
    mockRead.mockResolvedValue(new Map([[target, { contentB64: b64('x') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(mockWrite.mock.calls[0][1]).toEqual([
      { targetPath: target, mode: '0600', sudo: true },
    ]);
  });

  it('reports no change when content and mode already match', async () => {
    w('locked/out.txt', 'x');
    env.writeConfig(
      `files:\n${sudoEntry('locked/out.txt', '    mode: "0600"\n')}`,
    );
    lock();
    mockStat.mockResolvedValue(new Map([[target, statOf({ mode: '0600' })]]));
    mockRead.mockResolvedValue(new Map([[target, { contentB64: b64('x') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
  });

  it('rejects a symlink entry whose target is a directory', async () => {
    w('real.txt', 'real');
    env.writeConfig(`files:
  locked/link:
    src: ./real.txt
    symlink: true
    sudo: true
`);
    lock();
    mockStat.mockResolvedValue(
      new Map([[p('locked/link'), statOf({ isDirectory: true })]]),
    );
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('is a directory; cannot replace');
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it('leaves an existing matching symlink alone', async () => {
    w('real.txt', 'real');
    const log = p('hooks.log');
    env.writeConfig(`files:
  locked/link:
    src: ./real.txt
    symlink: true
    sudo: true
    on:
      update: echo update >> ${log}
`);
    lock();
    const link = p('locked/link');
    mockStat.mockResolvedValue(new Map([[link, statOf({ isSymlink: true })]]));
    mockRead.mockResolvedValue(
      new Map([[link, { contentB64: b64(p('real.txt')), isSymlink: true }]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(fs.existsSync(log)).toBe(false);
  });

  it('leaves an existing matching symlink without hooks alone', async () => {
    w('real.txt', 'real');
    env.writeConfig(`files:
  locked/link:
    src: ./real.txt
    symlink: true
    sudo: true
`);
    lock();
    const link = p('locked/link');
    mockStat.mockResolvedValue(new Map([[link, statOf({ isSymlink: true })]]));
    mockRead.mockResolvedValue(
      new Map([[link, { contentB64: b64(p('real.txt')), isSymlink: true }]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('replaces an existing symlink and records it as v0', async () => {
    w('real.txt', 'real');
    env.writeConfig(`files:
  locked/link:
    src: ./real.txt
    symlink: true
    sudo: true
`);
    lock();
    const link = p('locked/link');
    mockStat.mockResolvedValue(new Map([[link, statOf({ isSymlink: true })]]));
    mockRead.mockResolvedValue(
      new Map([[link, { contentB64: b64('elsewhere'), isSymlink: true }]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readlinkSync(link)).toBe(p('real.txt'));
    expect(history().readVersion(link, 0)?.toString()).toBe('elsewhere');
    expect(history().getFileMeta(link)?.v0IsSymlink).toBe(true);
  });

  it('exits 2 when the stat-read fails', async () => {
    env.writeConfig(`files:\n${sudoEntry('locked/out.txt')}`);
    lock();
    mockStat.mockRejectedValue(new Error('denied'));
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('stat-read failed: denied');
  });

  it('reports a stat-read failure that is not an Error', async () => {
    env.writeConfig(`files:\n${sudoEntry('locked/out.txt')}`);
    lock();
    mockStat.mockRejectedValue('denied');
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('stat-read failed: denied');
  });
});

suite('pull: sudo stale-file cleanup', () => {
  async function pullThenDrop(extra = ''): Promise<void> {
    env.writeConfig(`files:\n${sudoEntry('out.txt')}`);
    expect((await pull()).code).toBe(0);
    env.writeConfig(`files:\n${extra}`);
    if (!extra) env.writeConfig('files: {}\n');
  }

  it('deletes a stale sudo file through the session', async () => {
    await pullThenDrop();
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Wrote 1 file(s).');
    expect(sessions.at(-1)!.exec).toHaveBeenCalledWith(
      [{ type: 'delete', targetPath: p('out.txt') }],
      true,
    );
    expect(history().getLastPullFiles()).toEqual([]);
  });

  it('treats a skipped deletion as already clean', async () => {
    await pullThenDrop();
    execImpl = () => [{ ok: true, skipped: true }];
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(history().getLastPullFiles()).toEqual([]);
  });

  it('warns about failed deletions and a crashed worker', async () => {
    await pullThenDrop();
    execImpl = () => [{ ok: false, error: 'denied' }, { ok: false }];
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(`could not delete ${p('out.txt')}: denied`);
    expect(res.stderr).toContain(
      'privileged worker crashed during stale-file cleanup: worker exited unexpectedly',
    );
  });

  it('reports the crash sentinel error and ignores missing results', async () => {
    await pullThenDrop();
    execImpl = () => [{ ok: false }, { ok: false, error: 'killed' }];
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain('could not delete');
    expect(res.stderr).toContain('stale-file cleanup: killed');
  });

  it('warns when the session fails during deletion', async () => {
    await pullThenDrop();
    execImpl = () => {
      throw new Error('worker died');
    };
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('could not delete');
    expect(res.stderr).toContain('worker died');
  });

  it('warns when the session fails with a value that is not an Error', async () => {
    await pullThenDrop();
    execImpl = () => {
      throwNonError('worker died');
    };
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(
      `could not delete ${p('out.txt')}: worker died`,
    );
  });

  it('exits 2 when reading the deletion results throws', async () => {
    await pullThenDrop();
    execImpl = () => [
      {
        get ok(): boolean {
          return throwNonError('garbled result');
        },
      },
    ];
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(
      'Privileged stale-file cleanup failed: garbled result',
    );
  });

  it('exits 2 when no session exists for the identity', async () => {
    await pullThenDrop();
    mockOpen.mockImplementation(() => new Map());
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Privileged stale-file cleanup failed');
  });

  it('cleans up the ref of a stale sudo file that is already gone', async () => {
    w('src.txt', 'other');
    await pullThenDrop(`  other.txt:\n    src: ./src.txt\n`);
    fs.rmSync(p('out.txt'));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Wrote 1 file(s).');
    expect(
      history()
        .getLastPullFiles()
        .map((f) => f.absolutePath),
    ).toEqual([p('other.txt')]);
  });

  it('warns when a regular stale file cannot be deleted', async () => {
    w('d/src.txt', 'x');
    env.writeConfig(`files:\n  d/out.txt:\n    src: ./d/src.txt\n`);
    expect((await pull()).code).toBe(0);
    env.writeConfig('files: {}\n');
    fs.chmodSync(p('d'), 0o555);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(`could not delete ${p('d/out.txt')}`);
  });
});

suite('pull: sudo stale restore', () => {
  async function overwriteThenDrop(rel = 'out.txt'): Promise<string> {
    const file = w(rel, 'orig');
    env.writeConfig(`files:\n${sudoEntry(rel)}`);
    expect((await pull()).code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    env.writeConfig('files: {}\n');
    return file;
  }

  it('refuses a sudo stale restore on Windows', async () => {
    await overwriteThenDrop();
    // Report win32 only from the stale-file scan on, after the fetch loop
    // resolved paths with the real platform.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const orig = Object.getOwnPropertyDescriptor(
      HistoryManager.prototype,
      'getLastPullFiles',
    )!.value as (this: HistoryManager) => PullLogFileRef[];
    vi.spyOn(HistoryManager.prototype, 'getLastPullFiles').mockImplementation(
      function (this: HistoryManager) {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        return orig.call(this);
      },
    );
    let res;
    try {
      res = await pull();
    } finally {
      Object.defineProperty(process, 'platform', desc);
    }
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('sudo is not supported on Windows');
  });

  it('restores v0 through the privileged session', async () => {
    const file = await overwriteThenDrop();
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
    const restore = mockWrite.mock.calls.at(-1)![0];
    expect(restore.map((t) => t.targetPath)).toEqual([file]);
  });

  it('skips restoring an unreadable file that already matches', async () => {
    const file = await overwriteThenDrop();
    fs.writeFileSync(file, 'orig');
    fs.chmodSync(file, 0o000);
    mockRead.mockResolvedValue(new Map([[file, { contentB64: b64('orig') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(history().getLastPullFiles()).toEqual([]);
  });

  it('does not open a session for a stale restore that already matches', async () => {
    const file = await overwriteThenDrop();
    fs.writeFileSync(file, 'orig');
    env.writeConfig(`files:
  other.txt:
    src:
      - raw: o
`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Wrote 1 file(s).');
    expect(mockOpen).toHaveBeenLastCalledWith(new Set());
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('restores an unreadable file when the read fails or differs', async () => {
    const file = await overwriteThenDrop();
    fs.chmodSync(file, 0o000);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('restores an unreadable file that is now a symlink', async () => {
    const file = await overwriteThenDrop();
    fs.chmodSync(file, 0o000);
    mockRead.mockResolvedValue(
      new Map([[file, { contentB64: b64('/x'), isSymlink: true }]]),
    );
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('restores an unreadable file whose content differs', async () => {
    const file = await overwriteThenDrop();
    fs.chmodSync(file, 0o000);
    mockRead.mockResolvedValue(new Map([[file, { contentB64: b64('x') }]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('throws when the stale pre-read result is missing', async () => {
    const file = await overwriteThenDrop();
    fs.chmodSync(file, 0o000);
    mockRead.mockResolvedValue(new Map());
    const res = await pull();
    expect(String(res.thrown)).toContain(
      'missing pre-read result for sudo stale-restore target',
    );
  });

  it('recreates a missing file behind a non-searchable directory', async () => {
    const file = await overwriteThenDrop('locked/out.txt');
    fs.rmSync(file);
    fs.chmodSync(p('locked'), 0o600);
    mockStat.mockResolvedValue(new Map([[file, statOf({ exists: false })]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('restores an existing file behind a non-searchable directory', async () => {
    const file = await overwriteThenDrop('locked/out.txt');
    fs.chmodSync(p('locked'), 0o600);
    mockStat.mockResolvedValue(new Map([[file, statOf({})]]));
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  it('ignores a missing stat-read result for a stale restore', async () => {
    const file = await overwriteThenDrop('locked/out.txt');
    fs.chmodSync(p('locked'), 0o600);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('orig');
  });

  describe('pre-avanti symlinks', () => {
    async function linkThenDrop(): Promise<string> {
      w('locked/target.txt', 't');
      const link = p('locked/link');
      fs.symlinkSync('target.txt', link);
      env.writeConfig(`files:\n${sudoEntry('locked/link')}`);
      expect((await pull()).code).toBe(0);
      expect(history().getFileMeta(link)?.v0IsSymlink).toBe(true);
      env.writeConfig('files: {}\n');
      fs.chmodSync(p('locked'), 0o600);
      return link;
    }

    it('recreates a missing pre-avanti symlink', async () => {
      const link = await linkThenDrop();
      mockStat.mockResolvedValue(new Map([[link, statOf({ exists: false })]]));
      const res = await pull();
      expect(res.code).toBe(0);
      expect(fs.readlinkSync(link)).toBe('target.txt');
    });

    it('refuses to restore a symlink over a directory', async () => {
      const link = await linkThenDrop();
      mockStat.mockResolvedValue(
        new Map([[link, statOf({ isDirectory: true })]]),
      );
      const res = await pull();
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('is a directory; cannot replace');
    });

    it('restores over an existing file', async () => {
      const link = await linkThenDrop();
      mockStat.mockResolvedValue(new Map([[link, statOf({})]]));
      const res = await pull();
      expect(res.code).toBe(0);
      expect(fs.readlinkSync(link)).toBe('target.txt');
    });
  });
});

suite('pull: write failures', () => {
  function lastFiles(): string[] {
    return history()
      .getLastPullFiles()
      .map((f) => f.absolutePath)
      .sort();
  }

  it('records partial history for a partial regular write', async () => {
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
  b.txt:
    src:
      - raw: b
`);
    mockAtomicWrite.mockImplementation(() => {
      throw new AtomicWritePartialError('disk full', [p('a.txt')]);
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Write failed: disk full');
    expect(lastFiles()).toEqual([p('a.txt')]);
  });

  it('records partial history for a partial sudo write', async () => {
    env.writeConfig(
      `files:\n${sudoEntry('a.txt', '', 'a')}${sudoEntry('b.txt', '', 'b')}`,
    );
    mockWrite.mockRejectedValue(
      new SudoWritePartialError('worker failed', [p('a.txt')]),
    );
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Write failed: worker failed');
    expect(lastFiles()).toEqual([p('a.txt')]);
  });

  it('records completed sudo writes when the regular write fails', async () => {
    w('orig.txt', 'orig');
    env.writeConfig(`files:\n${sudoEntry('orig.txt')}`);
    expect((await pull()).code).toBe(0);
    env.writeConfig(`files:
${sudoEntry('s.txt')}${sudoEntry('m.txt', '    mode: "0600"\n')}  r.txt:
    src:
      - raw: r
`);
    w('m.txt', 'x');
    fs.chmodSync(p('m.txt'), 0o644);
    mockAtomicWrite.mockImplementation(() => {
      throw new Error('EIO');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Write failed: EIO');
    expect(lastFiles()).toEqual([p('s.txt')]);
  });

  it('records nothing when a plain write fails before any file landed', async () => {
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
`);
    mockAtomicWrite.mockImplementation(() => {
      throw new Error('EIO');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(lastFiles()).toEqual([]);
  });

  it('warns when the partial history cannot be saved', async () => {
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
`);
    mockAtomicWrite.mockImplementation(() => {
      throw new AtomicWritePartialError('disk full', [p('a.txt')]);
    });
    vi.spyOn(HistoryManager.prototype, 'closePullSession').mockImplementation(
      () => {
        throw new Error('ro');
      },
    );
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('could not save partial pull history');
  });
});

suite('pull: SHA updates for a config that is its own write target', () => {
  it('patches the config content in memory before writing it', async () => {
    const wrong = computeContentSha256('wrong');
    const cfg = `files:
  avanti.yml:
    src:
      path: ./tpl.yml
      sha: ${wrong}
`;
    w('tpl.yml', cfg);
    env.writeConfig(cfg);
    const res = await pull('--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('SHA pin(s) in config');
    const written = fs.readFileSync(env.configPath, 'utf8');
    expect(written).not.toContain(wrong);
    expect(written).toMatch(/sha: [0-9a-f]{64}/);
  });
});
