import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyInsertMode } from '../src/processors/insert';
import type { FileEntry } from '../src/types';

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    src: 'raw: test',
    target: 'out.txt',
    strategy: 'insert',
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-insert-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Plain text ────────────────────────────────────────────────────────────────

describe('plain text — no existing file', () => {
  it('returns processedText as-is when file does not exist', () => {
    const targetPath = path.join(tmpDir, 'new.txt');
    const result = applyInsertMode(makeEntry(), 'hello\n', null, targetPath);
    expect(result).toBe('hello\n');
  });
});

describe('plain text — first insert', () => {
  it('appends to existing content with newline separator', () => {
    const targetPath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(targetPath, 'original\n');
    const result = applyInsertMode(makeEntry(), 'inserted\n', null, targetPath);
    expect(result).toBe('original\ninserted\n');
  });

  it('appends with separator when existing content has no trailing newline', () => {
    const targetPath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(targetPath, 'original');
    const result = applyInsertMode(makeEntry(), 'inserted\n', null, targetPath);
    expect(result).toBe('original\ninserted\n');
  });
});

describe('plain text — subsequent insert (in-place replace)', () => {
  it('replaces the old fragment when source changes', () => {
    const targetPath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(targetPath, 'original\nold-fragment\n');
    const result = applyInsertMode(
      makeEntry(),
      'new-fragment\n',
      'old-fragment\n',
      targetPath,
    );
    expect(result).toBe('original\nnew-fragment\n');
  });

  it('appends when old fragment is no longer in the file (user removed it)', () => {
    const targetPath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(targetPath, 'original\n');
    const result = applyInsertMode(
      makeEntry(),
      'new-fragment\n',
      'old-fragment\n',
      targetPath,
    );
    expect(result).toBe('original\nnew-fragment\n');
  });
});

// ── JSON ──────────────────────────────────────────────────────────────────────

describe('JSON — first insert', () => {
  it('merges new keys into existing JSON', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(targetPath, JSON.stringify({ userKey: 'u' }, null, 2));
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ k1: 'v1' }),
      null,
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({ userKey: 'u', k1: 'v1' });
  });
});

describe('JSON — key update', () => {
  it('removes old contribution and merges updated keys', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ userKey: 'u', k1: 'v1' }, null, 2),
    );
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ k1: 'v1_new', k2: 'v2' }),
      JSON.stringify({ k1: 'v1' }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({
      userKey: 'u',
      k1: 'v1_new',
      k2: 'v2',
    });
  });
});

describe('JSON — key removal', () => {
  it('removes keys that disappeared from source', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ userKey: 'u', k1: 'v1', k2: 'v2' }, null, 2),
    );
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ k2: 'v2' }),
      JSON.stringify({ k1: 'v1', k2: 'v2' }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({ userKey: 'u', k2: 'v2' });
  });
});

describe('JSON — user override protection', () => {
  it('preserves user-modified values when source removes the key', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ userKey: 'u', k1: 'custom' }, null, 2),
    );
    // Source had k1: 'v1' previously; user changed it to 'custom'
    // Source now removes k1 entirely
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({}),
      JSON.stringify({ k1: 'v1' }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({ userKey: 'u', k1: 'custom' });
  });
});

describe('JSON — nested object removal', () => {
  it('recursively removes nested keys', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ outer: { userKey: 'u', k1: 'v1' } }, null, 2),
    );
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ outer: {} }),
      JSON.stringify({ outer: { k1: 'v1' } }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({ outer: { userKey: 'u' } });
  });

  it('removes outer object when avanti was sole contributor', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ outer: { k1: 'v1' } }, null, 2),
    );
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({}),
      JSON.stringify({ outer: { k1: 'v1' } }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({});
  });
});

describe('JSON — array handling', () => {
  it('removes old array items when source changes (concat strategy)', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    // User has [1,2] and avanti contributed [3,4]
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ arr: [1, 2, 3, 4] }, null, 2),
    );
    // Source now only contributes [5]
    const result = applyInsertMode(
      makeEntry({ json: { arrays: 'concat' } }),
      JSON.stringify({ arr: [5] }),
      JSON.stringify({ arr: [3, 4] }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({ arr: [1, 2, 5] });
  });

  it('removes array entirely when avanti was sole contributor', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(targetPath, JSON.stringify({ arr: ['a', 'b'] }, null, 2));
    const result = applyInsertMode(
      makeEntry({ json: { arrays: 'concat' } }),
      JSON.stringify({}),
      JSON.stringify({ arr: ['a', 'b'] }),
      targetPath,
    );
    expect(JSON.parse(result)).toEqual({});
  });
});

// ── YAML ──────────────────────────────────────────────────────────────────────

describe('YAML — first insert', () => {
  it('merges new keys into existing YAML', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'userKey: u\n');
    const result = applyInsertMode(
      makeEntry({ yaml: true }),
      'k1: v1\n',
      null,
      targetPath,
    );
    const parsed = result
      .trim()
      .split('\n')
      .reduce<Record<string, string>>((acc, line) => {
        const [k, v] = line.split(': ');
        acc[k] = v;
        return acc;
      }, {});
    expect(parsed).toMatchObject({ userKey: 'u', k1: 'v1' });
  });
});

describe('YAML — key removal', () => {
  it('removes keys that disappeared from source', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'userKey: u\nk1: v1\nk2: v2\n');
    const result = applyInsertMode(
      makeEntry({ yaml: true }),
      'k2: v2\n',
      JSON.stringify({ k1: 'v1', k2: 'v2' }),
      targetPath,
    );
    expect(result).not.toContain('k1');
    expect(result).toContain('k2');
    expect(result).toContain('userKey');
  });
});

describe('YAML — user override protection', () => {
  it('preserves user-modified values', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'userKey: u\nk1: custom\n');
    const result = applyInsertMode(
      makeEntry({ yaml: true }),
      '',
      JSON.stringify({ k1: 'v1' }),
      targetPath,
    );
    expect(result).toContain('k1: custom');
  });
});

// ── TOML ──────────────────────────────────────────────────────────────────────

describe('TOML — first insert', () => {
  it('merges new keys into existing TOML', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, 'userKey = "u"\n');
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      'k1 = "v1"\n',
      null,
      targetPath,
    );
    expect(result).toContain('userKey = "u"');
    expect(result).toContain('k1 = "v1"');
  });
});

describe('TOML — key removal', () => {
  it('removes keys that disappeared from source', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, 'userKey = "u"\nk1 = "v1"\nk2 = "v2"\n');
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      'k2 = "v2"\n',
      JSON.stringify({ k1: 'v1', k2: 'v2' }),
      targetPath,
    );
    expect(result).not.toContain('k1');
    expect(result).toContain('k2');
    expect(result).toContain('userKey');
  });
});
