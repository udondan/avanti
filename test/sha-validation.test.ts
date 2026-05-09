import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeContentSha256 } from '../src/sha';
import { applyUpdatedShas, writeUpdatedShas } from '../src/config-writeback';
import { fetchSource } from '../src/sources';
import { HistoryManager } from '../src/history';

// ---------------------------------------------------------------------------
// computeContentSha256
// ---------------------------------------------------------------------------

describe('computeContentSha256', () => {
  it('returns a 64-char hex string', () => {
    const sha = computeContentSha256('hello');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeContentSha256('foo')).toBe(computeContentSha256('foo'));
  });

  it('differs for different content', () => {
    expect(computeContentSha256('foo')).not.toBe(computeContentSha256('bar'));
  });
});

// ---------------------------------------------------------------------------
// writeUpdatedShas — comment preservation + correct node update
// ---------------------------------------------------------------------------

describe('writeUpdatedShas', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-sha-writeback-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const p = path.join(tmpDir, '.avanti.yml');
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('writes sha into a github source that has no existing sha', () => {
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
`);
    const sha = 'a'.repeat(64);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${'a'.repeat(64)}`);
  });

  it('overwrites existing sha', () => {
    const oldSha = 'b'.repeat(64);
    const newSha = 'c'.repeat(64);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
          sha: ${oldSha}
`);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', newSha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${newSha}`);
    expect(result).not.toContain(oldSha);
  });

  it('preserves comments in the config', () => {
    const sha = 'd'.repeat(64);
    const cfg = writeConfig(`# top-level comment
files:
  - target: out.txt # inline comment
    src:
      - github:
          repo: org/repo
          file: file.txt
`);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain('# top-level comment');
    expect(result).toContain('# inline comment');
  });

  it('updates the correct source when multiple sources are present', () => {
    const sha1 = 'e'.repeat(64);
    const sha2 = 'f'.repeat(64);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: first.txt
      - github:
          repo: org/repo
          file: second.txt
`);
    writeUpdatedShas(
      cfg,
      new Map([
        ['github:org/repo:first.txt', sha1],
        ['github:org/repo:second.txt', sha2],
      ]),
    );
    const result = fs.readFileSync(cfg, 'utf8');
    // Verify each SHA landed on its own source block, not the other
    const secondTxtPos = result.indexOf('second.txt');
    expect(result.indexOf(sha1)).toBeGreaterThan(-1);
    expect(result.indexOf(sha2)).toBeGreaterThan(-1);
    expect(result.indexOf(sha1)).toBeLessThan(secondTxtPos);
    expect(result.indexOf(sha2)).toBeGreaterThan(secondTxtPos);
  });

  it('includes ref in the label for github sources', () => {
    const sha = 'a1'.repeat(32);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
          ref: main
`);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt@main', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${sha}`);
  });

  it('writes sha for http map source', () => {
    const sha = 'c3'.repeat(32);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - http: https://example.com/file.txt
`);
    writeUpdatedShas(
      cfg,
      new Map([['http:https://example.com/file.txt', sha]]),
    );
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${sha}`);
  });

  it('updates vault source with field in label', () => {
    const sha = 'b2'.repeat(32);
    const cfg = writeConfig(`files:
  - target: secret.txt
    src:
      - vault:
          path: secret/data/app
          field: password
`);
    writeUpdatedShas(cfg, new Map([['vault:secret/data/app#password', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${sha}`);
  });

  it('is a no-op when the updates map is empty', () => {
    const original = `files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
`;
    const cfg = writeConfig(original);
    writeUpdatedShas(cfg, new Map());
    expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
  });

  it('does not match a label that differs only in ref', () => {
    const sha = 'aa'.repeat(32);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
          ref: main
`);
    // label without ref should NOT match source with ref
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).not.toContain(`sha:`);
  });

  it('writes sha for single-map src (non-sequence form)', () => {
    const sha = 'bb'.repeat(32);
    const cfg = writeConfig(`files:
  - target: out.txt
    src:
      github:
        repo: org/repo
        file: file.txt
`);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain(`sha: ${sha}`);
  });

  it('preserves comments in single-map src form', () => {
    const sha = 'cc'.repeat(32);
    const cfg = writeConfig(`# config comment
files:
  - target: out.txt # entry comment
    src:
      github:
        repo: org/repo
        file: file.txt
`);
    writeUpdatedShas(cfg, new Map([['github:org/repo:file.txt', sha]]));
    const result = fs.readFileSync(cfg, 'utf8');
    expect(result).toContain('# config comment');
    expect(result).toContain('# entry comment');
    expect(result).toContain(`sha: ${sha}`);
  });

  it('does not rewrite the file when no label matches', () => {
    const original = `files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
`;
    const cfg = writeConfig(original);
    const mtime0 = fs.statSync(cfg).mtimeMs;
    writeUpdatedShas(
      cfg,
      new Map([['github:other/repo:file.txt', 'a'.repeat(64)]]),
    );
    expect(fs.statSync(cfg).mtimeMs).toBe(mtime0);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
  });

  it('applyUpdatedShas returns null when no label matches', () => {
    const raw = `files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
`;
    const result = applyUpdatedShas(
      raw,
      new Map([['github:other/repo:file.txt', 'a'.repeat(64)]]),
    );
    expect(result).toBeNull();
  });

  it('applyUpdatedShas returns updated content when a label matches', () => {
    const sha = 'ee'.repeat(32);
    const raw = `files:
  - target: out.txt
    src:
      - github:
          repo: org/repo
          file: file.txt
`;
    const result = applyUpdatedShas(
      raw,
      new Map([['github:org/repo:file.txt', sha]]),
    );
    expect(result).not.toBeNull();
    expect(result).toContain(`sha: ${sha}`);
  });
});

// ---------------------------------------------------------------------------
// fetchSource — sourceRecords population
// ---------------------------------------------------------------------------

describe('fetchSource — sourceRecords', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-sources-sha-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty sourceRecords for a local file source', async () => {
    const srcFile = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(srcFile, 'hello world', 'utf8');

    const result = await fetchSource(
      { src: srcFile, target: 'output.txt' },
      tmpDir,
    );
    expect(result.sourceRecords).toHaveLength(0);
  });

  it('returns empty sourceRecords for a raw: source', async () => {
    const result = await fetchSource(
      { src: { raw: 'literal content' }, target: 'output.txt' },
      tmpDir,
    );
    expect(result.sourceRecords).toHaveLength(0);
  });

  it('sourceRecords are empty for plain string (non-http) sources', async () => {
    const srcFile = path.join(tmpDir, 'data.txt');
    fs.writeFileSync(srcFile, 'data', 'utf8');

    const result = await fetchSource(
      { src: srcFile, target: 'out.txt' },
      tmpDir,
    );
    expect(result.sourceRecords).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HistoryManager — stageFileVersion with sources (SourceShaRecord)
// ---------------------------------------------------------------------------

describe('HistoryManager.stageFileVersion with SHA records', () => {
  let tmpDir: string;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-sha-hist-test-'));
    historyDir = path.join(tmpDir, 'history');
    process.env.AVANTI_HISTORY_DIR = historyDir;
  });

  afterEach(() => {
    delete process.env.AVANTI_HISTORY_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores source SHA records in the pull log', () => {
    const h = new HistoryManager('/project/.avanti.yml', '/project');
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const targetPath = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(targetPath, 'original', 'utf8');

    const sources = [
      {
        label: 'github:org/repo:file.txt',
        observedSha: 'a'.repeat(64),
        expectedSha: undefined,
        accepted: false,
      },
    ];

    const { fileRef } = h.stageFileVersion(
      pullId,
      targetPath,
      'new content',
      false,
      sources,
    );

    expect(fileRef.sources).toHaveLength(1);
    expect(fileRef.sources![0].label).toBe('github:org/repo:file.txt');
    expect(fileRef.sources![0].observedSha).toBe('a'.repeat(64));
    expect(fileRef.sources![0].accepted).toBe(false);
  });

  it('marks accepted=true on accepted mismatched SHA records', () => {
    const h = new HistoryManager('/project/.avanti.yml', '/project');
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const targetPath = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(targetPath, 'original', 'utf8');

    const sources = [
      {
        label: 'github:org/repo:file.txt',
        observedSha: 'b'.repeat(64),
        expectedSha: 'c'.repeat(64),
        accepted: true,
      },
    ];

    const { fileRef } = h.stageFileVersion(
      pullId,
      targetPath,
      'changed',
      false,
      sources,
    );

    expect(fileRef.sources![0].accepted).toBe(true);
    expect(fileRef.sources![0].expectedSha).toBe('c'.repeat(64));
  });

  it('persists source SHA records to pulls.jsonl via closePullSession', () => {
    const h = new HistoryManager('/project/.avanti.yml', '/project');
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const targetPath = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(targetPath, 'original', 'utf8');

    const sources = [
      {
        label: 'gitlab:group/proj:config.yml@v1',
        observedSha: 'd'.repeat(64),
        expectedSha: undefined,
        accepted: false,
      },
    ];

    const { fileRef } = h.stageFileVersion(
      pullId,
      targetPath,
      'v1',
      false,
      sources,
    );
    h.closePullSession(pullId, '/project/.avanti.yml', [fileRef]);

    const pulls = h.listPulls();
    expect(pulls).toHaveLength(1);
    const ref = pulls[0].files[0];
    expect(ref.sources).toBeDefined();
    expect(ref.sources![0].label).toBe('gitlab:group/proj:config.yml@v1');
    expect(ref.sources![0].observedSha).toBe('d'.repeat(64));
  });

  it('omits sources field from fileRef when no sources provided', () => {
    const h = new HistoryManager('/project/.avanti.yml', '/project');
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const targetPath = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(targetPath, 'original', 'utf8');

    const { fileRef } = h.stageFileVersion(
      pullId,
      targetPath,
      'content',
      false,
    );

    expect(fileRef.sources).toBeUndefined();
  });
});
