// In-process tests for `avanti revert`. History is built directly through
// HistoryManager; the prompt and the privileged writer functions are mocked so
// every branch (sudo, partial-failure, Windows) can be exercised without a TTY
// or real sudo.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/prompt', () => ({ confirm: vi.fn() }));
vi.mock('../src/writer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/writer')>();
  return {
    ...real,
    atomicWrite: vi.fn(real.atomicWrite),
    openPrivilegedSessions: vi.fn(() => new Map()),
    closeAllSessions: vi.fn(),
    sudoAtomicWrite: vi.fn(() => Promise.resolve(0)),
    sudoAtomicDelete: vi.fn(() => Promise.resolve()),
  };
});

import { confirm } from '../src/prompt';
import * as writer from '../src/writer';
import { HistoryManager, PullLogFileRef } from '../src/history';
import { revertCommand } from '../src/commands/revert';
import { computeContentSha256 } from '../src/sha';

const posixOnly = it.skipIf(process.platform === 'win32');

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let tmpDir: string;
let historyDir: string;
let configPath: string;
let prevHistoryDir: string | undefined;

function history(): HistoryManager {
  return new HistoryManager(configPath, tmpDir);
}

interface StageSpec {
  path: string;
  content: string;
  isNew: boolean;
  sudo?: true | string;
  isSymlink?: boolean;
}

/** Records one pull in history, then writes the pulled content to disk. */
function recordPull(specs: StageSpec[]): string {
  const h = history();
  h.ensureStorageDir();
  const pullId = h.openPullSession();
  const refs: PullLogFileRef[] = [];
  for (const s of specs) {
    const { fileRef } = h.stageFileVersion(
      pullId,
      s.path,
      Buffer.from(s.content),
      s.isNew,
      undefined,
      s.sudo,
      undefined,
      s.isSymlink,
    );
    refs.push(fileRef);
  }
  h.closePullSession(pullId, configPath, refs);
  for (const s of specs) {
    rmSync(s.path, { force: true, recursive: true });
    if (s.isSymlink) symlinkSync(s.content, s.path);
    else writeFileSync(s.path, s.content);
  }
  return pullId;
}

function projectDir(): string {
  return join(
    historyDir,
    'projects',
    computeContentSha256(`${configPath}|${tmpDir}`),
  );
}

function removeVersion(absPath: string, version: number): void {
  rmSync(
    join(projectDir(), 'files', computeContentSha256(absPath), `v${version}`),
  );
}

async function run(args: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...a) => void out.push(a.join(' ')));
  const error = vi
    .spyOn(console, 'error')
    .mockImplementation((...a) => void err.push(a.join(' ')));
  const warn = vi
    .spyOn(console, 'warn')
    .mockImplementation((...a) => void err.push(a.join(' ')));
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(Number(code ?? 0));
  });
  process.exitCode = undefined;
  const program = new Command()
    .exitOverride()
    .option('-c, --config <path>')
    .option('-w, --working-dir <path>');
  program.addCommand(revertCommand());
  let exitCode: number;
  try {
    await program.parseAsync(
      ['--config', configPath, '--working-dir', tmpDir, 'revert', ...args],
      { from: 'user' },
    );
    exitCode = Number(process.exitCode ?? 0);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    exitCode = e.code;
  } finally {
    process.exitCode = undefined;
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    exit.mockRestore();
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

function withPlatform<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  return fn().finally(() =>
    Object.defineProperty(process, 'platform', original),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-revert-'));
  historyDir = mkdtempSync(join(tmpdir(), 'avanti-revert-hist-'));
  configPath = join(tmpDir, 'avanti.yml');
  writeFileSync(configPath, 'files: {}\n');
  prevHistoryDir = process.env.AVANTI_HISTORY_DIR;
  process.env.AVANTI_HISTORY_DIR = historyDir;
  vi.mocked(confirm).mockReset();
  vi.mocked(writer.atomicWrite).mockClear();
  vi.mocked(writer.openPrivilegedSessions).mockClear();
  vi.mocked(writer.sudoAtomicWrite).mockClear();
  vi.mocked(writer.sudoAtomicDelete).mockClear();
});

afterEach(() => {
  if (prevHistoryDir === undefined) delete process.env.AVANTI_HISTORY_DIR;
  else process.env.AVANTI_HISTORY_DIR = prevHistoryDir;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
});

describe('revert: preconditions', () => {
  it('exits 2 when there is no history', async () => {
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No history found');
  });

  it('exits 0 when the pull log is empty', async () => {
    history().ensureStorageDir();
    writeFileSync(join(projectDir(), 'pulls.jsonl'), '');
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No pull history recorded yet.');
  });

  it('exits 2 for an unknown pull ID', async () => {
    recordPull([{ path: join(tmpDir, 'a.txt'), content: 'a', isNew: true }]);
    const r = await run(['deadbeef', '-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No pull found matching ID "deadbeef"');
  });

  it('resolves the default config path when --config is omitted', async () => {
    const out: string[] = [];
    const log = vi
      .spyOn(console, 'error')
      .mockImplementation((...a) => void out.push(a.join(' ')));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(Number(code ?? 0));
    });
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        revertCommand().parseAsync(['-y'], { from: 'user' }),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      exit.mockRestore();
    }
    expect(out.join('\n')).toContain('No history found');
  });
});

describe('revert: plan building', () => {
  it('undoes the only pull: restores originals and deletes new files', async () => {
    const existing = join(tmpDir, 'existing.txt');
    const created = join(tmpDir, 'created.txt');
    writeFileSync(existing, 'original\n');
    recordPull([
      { path: existing, content: 'pulled\n', isNew: false },
      { path: created, content: 'new\n', isNew: true },
    ]);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Undoing last pull');
    expect(r.stdout).toContain('Reverted 2 file(s).');
    expect(readFileSync(existing, 'utf8')).toBe('original\n');
    expect(existsSync(created)).toBe(false);
  });

  it('undoes the last of two pulls, dropping files that pull created', async () => {
    const a = join(tmpDir, 'a.txt');
    const b = join(tmpDir, 'b.txt');
    recordPull([{ path: a, content: 'a1\n', isNew: true }]);
    // b was re-created from scratch by the second pull even though tracked.
    recordPull([
      { path: a, content: 'a2\n', isNew: false },
      { path: b, content: 'b\n', isNew: true },
    ]);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(a, 'utf8')).toBe('a1\n');
    expect(existsSync(b)).toBe(false);
  });

  it('reverts to the state after a specific pull by short ID', async () => {
    const a = join(tmpDir, 'a.txt');
    const first = recordPull([{ path: a, content: 'a1\n', isNew: true }]);
    recordPull([{ path: a, content: 'a2\n', isNew: false }]);
    const r = await run([first.slice(0, 8), '-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `Reverting to state after pull ${first.slice(0, 8)}`,
    );
    expect(readFileSync(a, 'utf8')).toBe('a1\n');
  });

  it('reports nothing to revert when files already match', async () => {
    const a = join(tmpDir, 'a.txt');
    const existing = join(tmpDir, 'existing.txt');
    const gone = join(tmpDir, 'gone.txt');
    const first = recordPull([{ path: a, content: 'a\n', isNew: true }]);
    writeFileSync(existing, 'orig\n');
    recordPull([
      { path: existing, content: 'pulled\n', isNew: false },
      { path: gone, content: 'g\n', isNew: true },
    ]);
    // Put everything back by hand: a unchanged, existing at its original,
    // gone deleted → reverting to the first pull is a no-op.
    writeFileSync(existing, 'orig\n');
    unlinkSync(gone);
    const r = await run([first, '-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Nothing to revert');
  });

  it('skips files whose history version is missing', async () => {
    const a = join(tmpDir, 'a.txt');
    const existing = join(tmpDir, 'existing.txt');
    writeFileSync(existing, 'orig\n');
    const first = recordPull([
      { path: a, content: 'a1\n', isNew: true },
      { path: existing, content: 'pulled\n', isNew: false },
    ]);
    removeVersion(a, 1);
    removeVersion(existing, 0);
    // Snapshot of first contains `a` (v1 missing → skipped). Undo of the only
    // pull sends `existing` to v0 (missing → skipped).
    const r1 = await run([first, '-y']);
    expect(r1.stdout).toContain('Nothing to revert');
    const r2 = await run(['-y']);
    // `a` is deleted (new in the only pull); `existing` skipped.
    expect(r2.exitCode).toBe(0);
    expect(readFileSync(existing, 'utf8')).toBe('pulled\n');
    expect(existsSync(a)).toBe(false);
  });

  posixOnly(
    'routes sudo deletions and sudo writes through the privileged writer',
    async () => {
      const created = join(tmpDir, 'created.txt');
      const existing = join(tmpDir, 'existing.txt');
      writeFileSync(existing, 'orig\n');
      recordPull([
        { path: created, content: 'new\n', isNew: true, sudo: true },
        { path: existing, content: 'pulled\n', isNew: false, sudo: 'root' },
      ]);
      const r = await run(['-y']);
      expect(r.exitCode).toBe(0);
      expect(writer.sudoAtomicWrite).toHaveBeenCalledTimes(1);
      expect(writer.sudoAtomicDelete).toHaveBeenCalledWith(
        [[created, true]],
        false,
        expect.any(Map),
      );
      expect(r.stdout).toContain('Reverted 2 file(s).');
    },
  );

  it('warns that sudo files are skipped on Windows', async () => {
    const created = join(tmpDir, 'created.txt');
    recordPull([{ path: created, content: 'new\n', isNew: true, sudo: true }]);
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => undefined);
    const r = await withPlatform('win32', () => run(['-y']));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(
      '1 privileged file(s) were not reverted — sudo is not supported on Windows',
    );
    expect(writer.sudoAtomicDelete).not.toHaveBeenCalled();
  });
});

describe('revert: symlinks', () => {
  posixOnly('restores a symlink recorded in the target pull', async () => {
    const link = join(tmpDir, 'link');
    const first = recordPull([
      { path: link, content: 'target-a', isSymlink: true, isNew: true },
    ]);
    recordPull([
      { path: link, content: 'target-b', isSymlink: true, isNew: false },
    ]);
    const r = await run([first, '-y']);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(link)).toBe('target-a');
    // Second run: symlink already matches → nothing to do.
    const r2 = await run([first, '-y']);
    expect(r2.stdout).toContain('Nothing to revert');
  });

  posixOnly('refuses to replace a directory with a symlink', async () => {
    const link = join(tmpDir, 'link');
    const first = recordPull([
      { path: link, content: 'target-a', isSymlink: true, isNew: true },
    ]);
    unlinkSync(link);
    mkdirSync(link);
    const r = await run([first, '-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is a directory; cannot restore symlink');
  });

  posixOnly('errors on Windows for symlink restores', async () => {
    const link = join(tmpDir, 'link');
    const first = recordPull([
      { path: link, content: 'target-a', isSymlink: true, isNew: true },
    ]);
    const r = await withPlatform('win32', () => run([first, '-y']));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('cannot restore symlink on Windows');
  });

  posixOnly('restores a pre-avanti symlink', async () => {
    const p = join(tmpDir, 'cfg');
    symlinkSync('orig-target', p);
    recordPull([{ path: p, content: 'regular\n', isNew: false }]);
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(p)).toBe('orig-target');
    // Already restored → nothing to do.
    const r2 = await run(['-y']);
    expect(r2.stdout).toContain('Nothing to revert');
  });

  posixOnly(
    'refuses to restore a pre-avanti symlink over a directory',
    async () => {
      const p = join(tmpDir, 'cfg');
      symlinkSync('orig-target', p);
      recordPull([{ path: p, content: 'regular\n', isNew: false }]);
      rmSync(p);
      mkdirSync(p);
      const r = await run(['-y']);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('is a directory; cannot restore symlink');
    },
  );

  posixOnly('errors on Windows for pre-avanti symlink restores', async () => {
    const p = join(tmpDir, 'cfg');
    symlinkSync('orig-target', p);
    recordPull([{ path: p, content: 'regular\n', isNew: false }]);
    const r = await withPlatform('win32', () => run(['-y']));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('cannot restore pre-avanti symlink on Windows');
  });
});

describe('revert: confirmation and failures', () => {
  function setup(sudo?: true | string): string {
    const a = join(tmpDir, 'a.txt');
    recordPull([{ path: a, content: 'a\n', isNew: true, sudo }]);
    return a;
  }

  it('aborts when the prompt is declined', async () => {
    const a = setup();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Aborted.');
    expect(existsSync(a)).toBe(true);
  });

  it('applies when the prompt is accepted', async () => {
    const a = setup();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(confirm).toHaveBeenCalledWith('Apply? [y/N] ');
    expect(existsSync(a)).toBe(false);
  });

  it('exits 2 when privileged sessions cannot be opened', async () => {
    setup(true);
    vi.mocked(writer.openPrivilegedSessions).mockImplementationOnce(() => {
      throw new Error('sudo unavailable');
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('sudo unavailable');
  });

  it('exits 2 with a non-Error session failure', async () => {
    setup(true);
    vi.mocked(writer.openPrivilegedSessions).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- covers the non-Error branch
      throw 'plain string';
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('plain string');
  });

  function setupMixed(): { sudoFile: string; plain: string } {
    const sudoFile = join(tmpDir, 'sudo.txt');
    const plain = join(tmpDir, 'plain.txt');
    writeFileSync(sudoFile, 's0\n');
    writeFileSync(plain, 'p0\n');
    recordPull([
      { path: sudoFile, content: 's1\n', isNew: false, sudo: true },
      { path: plain, content: 'p1\n', isNew: false },
    ]);
    return { sudoFile, plain };
  }

  posixOnly('lists confirmed writes from a SudoWritePartialError', async () => {
    const { sudoFile } = setupMixed();
    vi.mocked(writer.sudoAtomicWrite).mockRejectedValueOnce(
      new writer.SudoWritePartialError('boom', [sudoFile]),
    );
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('partial revert — the following 1 file(s)');
    expect(r.stderr).toContain(`  ${sudoFile}`);
    expect(r.stderr).toContain('Revert failed: boom');
  });

  posixOnly(
    'lists sudo and regular writes when atomicWrite fails partially after sudo',
    async () => {
      const { sudoFile, plain } = setupMixed();
      vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
        throw new writer.AtomicWritePartialError('rename failed', [plain]);
      });
      const r = await run(['-y']);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('the following 2 file(s)');
      expect(r.stderr).toContain(`  ${sudoFile}`);
      expect(r.stderr).toContain(`  ${plain}`);
    },
  );

  posixOnly(
    'lists only sudo writes when atomicWrite fails before renaming',
    async () => {
      const { sudoFile } = setupMixed();
      vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
        throw new Error('staging failed');
      });
      const r = await run(['-y']);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('the following 1 file(s)');
      expect(r.stderr).toContain(`  ${sudoFile}`);
      expect(r.stderr).toContain('Revert failed: staging failed');
    },
  );

  it('lists regular writes from an AtomicWritePartialError without sudo', async () => {
    const a = setup();
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
      throw new writer.AtomicWritePartialError('partial', [a]);
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('the following 1 file(s)');
  });

  it('reports a plain failure without a partial-write warning', async () => {
    setup();
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- covers the non-Error branch
      throw 'weird';
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain('partial revert');
    expect(r.stderr).toContain('Revert failed: weird');
  });
});

// Sanity check that the helpers locate history storage correctly.
it('history project directory matches the HistoryManager layout', () => {
  recordPull([{ path: join(tmpDir, 'x.txt'), content: 'x', isNew: true }]);
  expect(readdirSync(join(historyDir, 'projects'))).toEqual([
    computeContentSha256(`${configPath}|${tmpDir}`),
  ]);
});
