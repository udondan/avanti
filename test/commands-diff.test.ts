// In-process tests for `avanti diff`, using local, raw and exec sources only.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryManager, PullLogFileRef } from '../src/history';
import { diffCommand } from '../src/commands/diff';
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

function w(rel: string, content: string): string {
  const p = join(tmpDir, rel);
  writeFileSync(p, content);
  return p;
}

function writeConfig(yaml: string): void {
  writeFileSync(configPath, yaml);
}

async function run(args: string[] = []): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const collect =
    (into: string[]) =>
    (...a: unknown[]): void =>
      void into.push(a.map(String).join(' '));
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(collect(out)),
    vi.spyOn(console, 'error').mockImplementation(collect(err)),
    vi.spyOn(console, 'warn').mockImplementation(collect(err)),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    }),
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(Number(code ?? 0));
    }),
  ];
  const program = new Command()
    .exitOverride()
    .option('-c, --config <path>')
    .option('-w, --working-dir <path>')
    .option('--via <transport>');
  program.addCommand(diffCommand());
  let exitCode = -1;
  try {
    await program.parseAsync(
      ['--config', configPath, '--working-dir', tmpDir, 'diff', ...args],
      { from: 'user' },
    );
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    exitCode = e.code;
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

interface StageSpec {
  path: string;
  content: string;
  isNew: boolean;
  isSymlink?: boolean;
}

function recordPull(specs: StageSpec[]): string {
  const h = new HistoryManager(configPath, tmpDir);
  h.ensureStorageDir();
  const pullId = h.openPullSession();
  const refs: PullLogFileRef[] = [];
  for (const s of specs) {
    refs.push(
      h.stageFileVersion(
        pullId,
        s.path,
        Buffer.from(s.content),
        s.isNew,
        undefined,
        undefined,
        undefined,
        s.isSymlink,
      ).fileRef,
    );
  }
  h.closePullSession(pullId, configPath, refs);
  return pullId;
}

function projectDir(): string {
  return join(
    historyDir,
    'projects',
    computeContentSha256(`${configPath}|${tmpDir}`),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-diffcmd-'));
  historyDir = mkdtempSync(join(tmpdir(), 'avanti-diffcmd-hist-'));
  configPath = join(tmpDir, 'avanti.yml');
  prevHistoryDir = process.env.AVANTI_HISTORY_DIR;
  process.env.AVANTI_HISTORY_DIR = historyDir;
});

afterEach(() => {
  if (prevHistoryDir === undefined) delete process.env.AVANTI_HISTORY_DIR;
  else process.env.AVANTI_HISTORY_DIR = prevHistoryDir;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
});

describe('diff: basic results', () => {
  it('exits 0 when nothing changes', async () => {
    w('out.txt', 'hello');
    writeConfig(`files:\n  out.txt:\n    src:\n      - raw: hello\n`);
    expect((await run()).exitCode).toBe(0);
  });

  it('exits 1 when a file would change', async () => {
    writeConfig(`files:\n  out.txt:\n    src:\n      - raw: hello\n`);
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('out.txt');
  });

  it('exits 2 when the config cannot be loaded', async () => {
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toBe('');
  });

  it('exits 2 when a variable cannot be resolved', async () => {
    writeConfig(
      `variables:\n  broken:\n    src: ./missing.txt\nfiles:\n  out.txt:\n    src:\n      - raw: x\n`,
    );
    expect((await run()).exitCode).toBe(2);
  });

  it('exits 2 on a dependency cycle', async () => {
    writeConfig(
      `files:\n  a.txt:\n    src: ./b.txt\n  b.txt:\n    src: ./a.txt\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(2);
  });

  it('exits 2 when a source fails', async () => {
    writeConfig(`files:\n  out.txt:\n    src: ./missing.txt\n`);
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Error processing');
  });

  it('skips entries whose condition is false', async () => {
    writeConfig(
      `files:\n  out.txt:\n    src:\n      - raw: x\n    if:\n      exists: ./nope\n`,
    );
    expect((await run()).exitCode).toBe(0);
  });

  it('evaluates target_exists against the entry target', async () => {
    w('out.txt', 'old');
    writeConfig(
      `files:\n  out.txt:\n    src:\n      - raw: x\n    if:\n      target_exists: false\n`,
    );
    expect((await run()).exitCode).toBe(0);
  });

  it('warns on a SHA mismatch', async () => {
    w('src.txt', 'content');
    writeConfig(
      `files:\n  out.txt:\n    src:\n      - path: ./src.txt\n        sha: "${'0'.repeat(64)}"\n`,
    );
    const r = await run();
    expect(r.stderr).toContain('SHA mismatch');
  });

  posixOnly(
    'applies template, replace and on.write to text content',
    async () => {
      writeConfig(
        `variables:\n  name: world\nfiles:\n  out.txt:\n    src:\n      - raw: "hi {{ name }} FOO"\n    template: handlebars\n    replace:\n      - from: FOO\n        to: BAR\n    on:\n      write: "cat"\n`,
      );
      const r = await run();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('hi world BAR');
    },
  );

  it('diffs binary content without text processing', async () => {
    writeFileSync(join(tmpDir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
    writeConfig(
      `files:\n  out.dat:\n    src: ./bin.dat\n    replace:\n      - from: a\n        to: b\n`,
    );
    expect((await run()).exitCode).toBe(1);
  });

  it('skips an insert entry whose fragment is unchanged', async () => {
    const host = w('host.txt', 'base\ninserted\n');
    writeConfig(
      `files:\n  host.txt:\n    src:\n      - raw: "inserted"\n    strategy: insert\n`,
    );
    new HistoryManager(configPath, tmpDir).saveInsertedFragment(
      host,
      'inserted',
      'inserted',
    );
    expect((await run()).exitCode).toBe(0);
  });

  it('diffs an insert entry with a new fragment', async () => {
    w('host.txt', 'base\n');
    writeConfig(
      `files:\n  host.txt:\n    src:\n      - raw: "frag"\n    strategy: insert\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('frag');
  });

  posixOnly('diffs through a followed symlink', async () => {
    w('real.txt', 'old\n');
    symlinkSync('real.txt', join(tmpDir, 'link.txt'));
    writeConfig(
      `files:\n  link.txt:\n    src:\n      - raw: "new"\n    followSymlink: true\n  copy.txt:\n    src: ./link.txt\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('real.txt');
  });
});

describe('diff: symlink entries', () => {
  posixOnly('shows a new symlink', async () => {
    w('target.txt', 't');
    writeConfig(
      `files:\n  link:\n    src: ./target.txt\n    symlink: true\n  copy.txt:\n    src: ./link\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('new symlink');
  });

  posixOnly('accepts an object src and a directory src', async () => {
    mkdirSync(join(tmpDir, 'dir'));
    writeConfig(
      `files:\n  link:\n    src:\n      path: ./dir\n    symlink: true\n`,
    );
    expect((await run()).exitCode).toBe(1);
  });

  posixOnly('skips an optional missing src', async () => {
    writeConfig(
      `files:\n  link:\n    src:\n      path: ./missing\n      optional: true\n    symlink: true\n`,
    );
    expect((await run()).exitCode).toBe(0);
  });

  posixOnly('links an optional src that exists', async () => {
    w('target.txt', 't');
    writeConfig(
      `files:\n  link:\n    src:\n      path: ./target.txt\n      optional: true\n    symlink: true\n`,
    );
    expect((await run()).exitCode).toBe(1);
  });

  posixOnly('errors when the target is a directory', async () => {
    w('target.txt', 't');
    mkdirSync(join(tmpDir, 'link'));
    writeConfig(`files:\n  link:\n    src: ./target.txt\n    symlink: true\n`);
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is a directory; cannot replace with a symlink');
  });

  posixOnly('errors on Windows', async () => {
    w('target.txt', 't');
    writeConfig(`files:\n  link:\n    src: ./target.txt\n    symlink: true\n`);
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let r: RunResult;
    try {
      r = await run();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('symlink entries are not supported on Windows');
  });
});

describe('diff: $self', () => {
  it('re-evaluates the merged config and diffs the config file', async () => {
    const remote = w(
      'remote.yml',
      `files:\n  $self:\n    src: ./remote.yml\n  out.txt:\n    src:\n      - raw: merged\n`,
    );
    writeConfig(`files:\n  $self:\n    src: ${remote}\n`);
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      '$self config resolved; re-evaluating with merged config...',
    );
    expect(r.stdout).toContain('merged');
    expect(r.stdout).toContain('avanti.yml');
  });

  it('stops when the merged config has no $self', async () => {
    const remote = w(
      'remote.yml',
      `files:\n  out.txt:\n    src:\n      - raw: merged\n`,
    );
    writeConfig(`files:\n  $self:\n    src: ${remote}\n`);
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('re-evaluating');
  });

  it('only diffs the config when the merged config has no other files', async () => {
    const remote = w('remote.yml', `files:\n  $self:\n    src: ./remote.yml\n`);
    writeConfig(`files:\n  $self:\n    src: ${remote}\n`);
    expect((await run()).exitCode).toBe(1);
  });

  it('replaces an entry that also targets the config file', async () => {
    const remote = w(
      'remote.yml',
      `files:\n  avanti.yml:\n    src:\n      - raw: other\n`,
    );
    writeConfig(`files:\n  $self:\n    src: ${remote}\n`);
    const r = await run();
    expect(r.exitCode).toBe(1);
    // The config file is diffed once, against the merged $self content.
    expect(r.stdout.match(/^Index: .*avanti\.yml$/gm)).toHaveLength(1);
    expect(r.stdout).toContain('+      - raw: other');
  });

  it('exits 2 when the merged config is invalid', async () => {
    w('remote.yml', `files: [not, a, map]\n`);
    writeConfig(`files:\n  $self:\n    src: ./remote.yml\n`);
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('$self config is invalid');
  });

  it('exits 2 when re-evaluation fails', async () => {
    w('remote.yml', `files:\n  $self:\n    src: ./missing.yml\n`);
    writeConfig(`files:\n  $self:\n    src: ./remote.yml\n`);
    const r = await run();
    expect(r.exitCode).toBe(2);
  });

  it('exits 2 when $self resolves to several files', async () => {
    mkdirSync(join(tmpDir, 'many'));
    w('many/a.txt', 'files: {}\n');
    w('many/b.txt', 'files: {}\n');
    writeConfig(`files:\n  $self:\n    src: ./many\n`);
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('$self must resolve to exactly one file');
  });

  it('skips $self when its condition is false', async () => {
    writeConfig(
      `files:\n  $self:\n    src: ./missing.yml\n    if:\n      exists: ./nope\n  out.txt:\n    src:\n      - raw: x\n`,
    );
    expect((await run()).exitCode).toBe(1);
  });

  it('evaluates target_exists against the config path for $self', async () => {
    const remote = w(
      'remote.yml',
      `files:\n  out.txt:\n    src:\n      - raw: merged\n`,
    );
    writeConfig(
      `files:\n  $self:\n    src:\n      - path: ${remote}\n        if:\n          target_exists: true\n    if:\n      target_exists: true\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('merged');
  });

  it('stops when the merged $self is gated out by its condition', async () => {
    const remote = w(
      'remote.yml',
      `files:\n  $self:\n    src: ./remote.yml\n    if:\n      exists: ./nope\n  out.txt:\n    src:\n      - raw: merged\n`,
    );
    writeConfig(`files:\n  $self:\n    src: ${remote}\n`);
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('re-evaluating');
    expect(r.stdout).toContain('merged');
  });

  it('exits 2 when the $self condition throws', async () => {
    writeConfig(
      `files:\n  $self:\n    src: ./remote.yml\n    if:\n      exists: $undefinedVar\n`,
    );
    const r = await run();
    expect(r.exitCode).toBe(2);
  });
});

describe('diff <pullId>', () => {
  beforeEach(() => writeConfig('files: {}\n'));

  it('exits 2 without history', async () => {
    const r = await run(['abc']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No history found');
  });

  it('exits 2 for an unknown pull', async () => {
    recordPull([{ path: w('a.txt', 'a'), content: 'a', isNew: true }]);
    const r = await run(['zzz']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No pull found matching ID "zzz"');
  });

  it('exits 0 for a pull without files', async () => {
    const id = recordPull([]);
    const r = await run([id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No changes would result');
  });

  it('shows modified, deleted and skipped files', async () => {
    const a = w('a.txt', 'now');
    const lost = w('lost.txt', 'x');
    const id = recordPull([
      { path: a, content: 'then', isNew: true },
      { path: lost, content: 'x', isNew: true },
    ]);
    const later = w('later.txt', 'later');
    recordPull([{ path: later, content: 'later', isNew: true }]);
    rmSync(join(projectDir(), 'files', computeContentSha256(lost), 'v1'));
    const r = await run([id.slice(0, 6)]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('later.txt');
    expect(r.stdout).toContain('then');
    expect(r.stdout).not.toContain('lost.txt');
  });

  it('exits 0 when the files match the pull', async () => {
    const a = w('a.txt', 'same');
    const id = recordPull([{ path: a, content: 'same', isNew: true }]);
    expect((await run([id])).exitCode).toBe(0);
  });

  posixOnly('shows a symlink from history', async () => {
    const link = join(tmpDir, 'link');
    const id = recordPull([
      { path: link, content: 'target', isNew: true, isSymlink: true },
    ]);
    const r = await run([id]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('-> target');
  });
});
