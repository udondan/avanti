// In-process tests for `avanti reset`. History is built directly through
// HistoryManager; the prompt and the privileged writer functions are mocked so
// every branch (sudo, partial-failure, Windows) can be exercised without a TTY
// or real sudo.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { resetCommand } from '../src/commands/reset';
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
  program.addCommand(resetCommand());
  let exitCode: number;
  try {
    await program.parseAsync(
      ['--config', configPath, '--working-dir', tmpDir, 'reset', ...args],
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
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-reset-'));
  historyDir = mkdtempSync(join(tmpdir(), 'avanti-reset-hist-'));
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

describe('reset: preconditions', () => {
  it('exits 0 when there is no history', async () => {
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No avanti history found. Nothing to reset.');
  });

  it('exits 0 when no files are tracked', async () => {
    history().ensureStorageDir();
    writeFileSync(join(projectDir(), 'pulls.jsonl'), '');
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No tracked files. Nothing to reset.');
  });

  it('resolves the default config path when --config is omitted', async () => {
    const out: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...a) => void out.push(a.join(' ')));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(Number(code ?? 0));
    });
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        resetCommand().parseAsync(['-y'], { from: 'user' }),
      ).rejects.toMatchObject({ code: 0 });
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      exit.mockRestore();
    }
    expect(out.join('\n')).toContain('No avanti history found');
  });
});

describe('reset: plan building', () => {
  it('restores originals and deletes created files', async () => {
    const existing = join(tmpDir, 'existing.txt');
    const created = join(tmpDir, 'created.txt');
    writeFileSync(existing, 'original\n');
    recordPull([
      { path: existing, content: 'pulled\n', isNew: false },
      { path: created, content: 'new\n', isNew: true },
    ]);
    recordPull([{ path: existing, content: 'pulled again\n', isNew: false }]);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('This will restore 2 tracked file(s)');
    expect(r.stdout).toContain('Restored 1 file(s), deleted 1 file(s).');
    expect(readFileSync(existing, 'utf8')).toBe('original\n');
    expect(existsSync(created)).toBe(false);
  });

  it('reports nothing to reset when files are already at pre-avanti state', async () => {
    const existing = join(tmpDir, 'existing.txt');
    const created = join(tmpDir, 'created.txt');
    const lost = join(tmpDir, 'lost.txt');
    writeFileSync(existing, 'original\n');
    writeFileSync(lost, 'lost\n');
    recordPull([
      { path: existing, content: 'pulled\n', isNew: false },
      { path: created, content: 'new\n', isNew: true },
      { path: lost, content: 'pulled\n', isNew: false },
    ]);
    writeFileSync(existing, 'original\n');
    unlinkSync(created);
    removeVersion(lost, 0);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      'Files are already at their pre-avanti state. Nothing to reset.',
    );
  });

  it('routes sudo deletions and sudo writes through the privileged writer', async () => {
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
    expect(r.stdout).toContain('Restored 1 file(s), deleted 1 file(s).');
  });

  it('warns that sudo files are skipped on Windows', async () => {
    const created = join(tmpDir, 'created.txt');
    recordPull([{ path: created, content: 'new\n', isNew: true, sudo: true }]);
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => undefined);
    const r = await withPlatform('win32', () => run(['-y']));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(
      '1 privileged file(s) were not reset — sudo is not supported on Windows',
    );
    expect(writer.sudoAtomicDelete).not.toHaveBeenCalled();
  });
});

describe('reset: symlinks', () => {
  posixOnly('restores a pre-avanti symlink', async () => {
    const p = join(tmpDir, 'cfg');
    symlinkSync('orig-target', p);
    recordPull([{ path: p, content: 'regular\n', isNew: false }]);
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    const r = await run(['-y']);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(p)).toBe('orig-target');
    const r2 = await run(['-y']);
    expect(r2.stdout).toContain('Nothing to reset');
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
      expect(r.stdout).not.toContain('This will restore');
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

describe('reset: confirmation and failures', () => {
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

  it('lists confirmed writes from a SudoWritePartialError', async () => {
    const { sudoFile } = setupMixed();
    vi.mocked(writer.sudoAtomicWrite).mockRejectedValueOnce(
      new writer.SudoWritePartialError('boom', [sudoFile]),
    );
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('partial reset — the following 1 file(s)');
    expect(r.stderr).toContain(`  ${sudoFile}`);
    expect(r.stderr).toContain('Reset failed: boom');
  });

  it('lists sudo and regular writes when atomicWrite fails partially after sudo', async () => {
    const { sudoFile, plain } = setupMixed();
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
      throw new writer.AtomicWritePartialError('rename failed', [plain]);
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('the following 2 file(s)');
    expect(r.stderr).toContain(`  ${sudoFile}`);
    expect(r.stderr).toContain(`  ${plain}`);
  });

  it('lists only sudo writes when atomicWrite fails before renaming', async () => {
    const { sudoFile } = setupMixed();
    vi.mocked(writer.atomicWrite).mockImplementationOnce(() => {
      throw new Error('staging failed');
    });
    const r = await run(['-y']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('the following 1 file(s)');
    expect(r.stderr).toContain(`  ${sudoFile}`);
    expect(r.stderr).toContain('Reset failed: staging failed');
  });

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
    expect(r.stderr).not.toContain('partial reset');
    expect(r.stderr).toContain('Reset failed: weird');
  });
});
