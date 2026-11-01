// In-process tests for `avanti log`. History is built directly through
// HistoryManager so every output variant can be checked without running pulls.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoryManager,
  PullLogFileRef,
  SourceShaRecord,
} from '../src/history';
import { logCommand } from '../src/commands/log';
import { computeContentSha256 } from '../src/sha';

let tmpDir: string;
let historyDir: string;
let configPath: string;
let prevHistoryDir: string | undefined;

interface StageSpec {
  path: string;
  content: string;
  isNew: boolean;
  sources?: SourceShaRecord[];
}

function recordPull(config: string, specs: StageSpec[]): string {
  const h = new HistoryManager(config, tmpDir);
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
        s.sources,
      ).fileRef,
    );
  }
  h.closePullSession(pullId, config, refs);
  for (const s of specs) writeFileSync(s.path, s.content);
  return pullId;
}

async function run(args: string[], withConfig = true): Promise<string> {
  const out: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...a) => void out.push(a.join(' ')));
  const program = new Command()
    .exitOverride()
    .option('-c, --config <path>')
    .option('-w, --working-dir <path>');
  program.addCommand(logCommand());
  const globals = withConfig
    ? ['--config', configPath, '--working-dir', tmpDir]
    : ['--working-dir', tmpDir];
  try {
    await program.parseAsync([...globals, 'log', ...args], { from: 'user' });
  } finally {
    log.mockRestore();
  }
  return out.join('\n');
}

const sha = (c: string): string => 'a'.repeat(8) + c.repeat(56);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-log-'));
  historyDir = mkdtempSync(join(tmpdir(), 'avanti-log-hist-'));
  configPath = join(tmpDir, 'avanti.yml');
  writeFileSync(configPath, 'files: {}\n');
  prevHistoryDir = process.env.AVANTI_HISTORY_DIR;
  process.env.AVANTI_HISTORY_DIR = historyDir;
});

afterEach(() => {
  if (prevHistoryDir === undefined) delete process.env.AVANTI_HISTORY_DIR;
  else process.env.AVANTI_HISTORY_DIR = prevHistoryDir;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
});

describe('log: pull history', () => {
  it('reports no history with an explicit config', async () => {
    expect(await run([])).toContain('No history recorded yet.');
  });

  it('reports no history when no project matches the working dir', async () => {
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect(await run([], false)).toContain('No history recorded yet.');
    } finally {
      process.chdir(cwd);
    }
  });

  it('lists pulls with file labels and source SHAs', async () => {
    const a = join(tmpDir, 'a.txt');
    const b = join(tmpDir, 'b.txt');
    writeFileSync(b, 'orig\n');
    const id = recordPull(configPath, [
      {
        path: a,
        content: 'a\n',
        isNew: true,
        sources: [
          {
            label: 'https://example.com/a',
            observedSha: sha('1'),
            expectedSha: undefined,
            accepted: false,
          },
          {
            label: 'https://example.com/b',
            observedSha: sha('2'),
            expectedSha: sha('3'),
            accepted: true,
          },
        ],
      },
      { path: b, content: 'b\n', isNew: false, sources: [] },
    ]);
    const out = await run([]);
    expect(out).toMatch(
      new RegExp(
        `pull ${id.slice(0, 8)}  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d [+-]\\d\\d:\\d\\d  avanti\\.yml`,
      ),
    );
    expect(out).toContain(`${a}  → v1  (new file)`);
    expect(out).toContain(`${b}  → v1  (modified)`);
    expect(out).toContain(`sha:${sha('1').slice(0, 16)}`);
    expect(out).toContain(
      `sha:${sha('2').slice(0, 16)}  ⚠ accepted (was: ${sha('3').slice(0, 16)})`,
    );
  });

  it('merges pulls of all configs for the working dir when --config is omitted', async () => {
    const other = join(tmpDir, 'other.yml');
    recordPull(configPath, [
      { path: join(tmpDir, 'a.txt'), content: 'a', isNew: true },
    ]);
    recordPull(other, [
      { path: join(tmpDir, 'b.txt'), content: 'b', isNew: true },
    ]);
    const out = await run([], false);
    expect(out).toContain('avanti.yml');
    expect(out).toContain('other.yml');
  });
});

describe('log <file>', () => {
  it('shows version history with original, current and source SHAs', async () => {
    const f = join(tmpDir, 'f.txt');
    writeFileSync(f, 'orig\n');
    const first = recordPull(configPath, [
      {
        path: f,
        content: 'one\n',
        isNew: false,
        sources: [
          {
            label: 'exec:echo one',
            observedSha: sha('4'),
            expectedSha: sha('5'),
            accepted: true,
          },
        ],
      },
    ]);
    const second = recordPull(configPath, [
      {
        path: f,
        content: 'two\n',
        isNew: false,
        sources: [
          {
            label: 'exec:echo two',
            observedSha: sha('6'),
            expectedSha: undefined,
            accepted: false,
          },
        ],
      },
    ]);
    const out = await run(['f.txt']);
    expect(out).toContain(`${f}\n`);
    expect(out).toContain(`v2    `);
    expect(out).toContain(`pull ${second.slice(0, 8)}  (current)`);
    expect(out).toContain(`pull ${first.slice(0, 8)}`);
    expect(out).toContain('(original, before avanti)');
    expect(out).toContain(
      `sha:${sha('4').slice(0, 16)}  ⚠ accepted (was: ${sha('5').slice(0, 16)})`,
    );
    expect(out).toContain(`sha:${sha('6').slice(0, 16)}`);
  });

  it('accepts an absolute path and shows versions without pull info', async () => {
    const f = join(tmpDir, 'f.txt');
    recordPull(configPath, [{ path: f, content: 'one\n', isNew: true }]);
    // Bump currentVersion beyond what the pull log knows about.
    const metaPath = join(
      historyDir,
      'projects',
      computeContentSha256(`${configPath}|${tmpDir}`),
      'files',
      computeContentSha256(f),
      'meta.json',
    );
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      currentVersion: number;
    };
    meta.currentVersion = 2;
    writeFileSync(metaPath, JSON.stringify(meta));
    const out = await run([f]);
    expect(out).toMatch(/v2 {4}— +— +\(current\)/);
    expect(out).toContain('v1  ');
  });

  it('picks the most recently pulled config when several track the dir', async () => {
    const other = join(tmpDir, 'other.yml');
    const empty = join(tmpDir, 'empty.yml');
    const f = join(tmpDir, 'f.txt');
    // A project without pulls sorts last.
    new HistoryManager(empty, tmpDir).ensureStorageDir();
    recordPull(configPath, [{ path: f, content: 'one\n', isNew: true }]);
    const later = recordPull(other, [
      { path: f, content: 'two\n', isNew: true },
    ]);
    const out = await run(['f.txt'], false);
    expect(out).toContain(`pull ${later.slice(0, 8)}`);
  });

  it('reports a file without history', async () => {
    recordPull(configPath, [
      { path: join(tmpDir, 'a.txt'), content: 'a', isNew: true },
    ]);
    const missing = join(tmpDir, 'missing.txt');
    expect(await run(['missing.txt'])).toContain(`No history for ${missing}.`);
  });
});
