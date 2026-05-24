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

describe('JSON — property order preservation', () => {
  it('key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(targetPath, '{\n  "a": 99,\n  "b": 2,\n  "c": 3\n}\n');
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ a: 100 }),
      JSON.stringify({ a: 99 }),
      targetPath,
    );
    expect(result).toBe('{\n  "a": 100,\n  "b": 2,\n  "c": 3\n}\n');
  });

  it('nested key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ config: { a: 99, userProp: 'x' } }, null, 2),
    );
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ config: { a: 100 } }),
      JSON.stringify({ config: { a: 99 } }),
      targetPath,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed).toEqual({ config: { a: 100, userProp: 'x' } });
    expect(Object.keys(parsed['config'] as object)).toEqual(['a', 'userProp']);
  });

  it('top-level key order matches original file when key is updated', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(targetPath, '{\n  "z": 1,\n  "a": 99,\n  "m": 3\n}\n');
    const result = applyInsertMode(
      makeEntry({ json: true }),
      JSON.stringify({ a: 100 }),
      JSON.stringify({ a: 99 }),
      targetPath,
    );
    expect(result).toBe('{\n  "z": 1,\n  "a": 100,\n  "m": 3\n}\n');
  });

  it('uses remove-then-merge (no order preservation) when conflicts: first_wins', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    // 'a' is first in the existing file but was contributed by avanti (value 99)
    fs.writeFileSync(targetPath, '{\n  "a": 99,\n  "b": 2\n}\n');
    const result = applyInsertMode(
      makeEntry({ json: { conflicts: 'first_wins' } }),
      JSON.stringify({ a: 100 }),
      JSON.stringify({ a: 99 }),
      targetPath,
    );
    // first_wins: 'a' is removed then re-merged; new value wins (no conflict)
    expect(JSON.parse(result)).toEqual({ b: 2, a: 100 });
    // 'a' must appear after 'b' — no order preservation under first_wins
    expect(Object.keys(JSON.parse(result) as object)).toEqual(['b', 'a']);
  });

  it('does not throw with conflicts: abort when updated key is removed before merge', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(targetPath, JSON.stringify({ a: 99, b: 2 }, null, 2));
    // With abort, the old value must be removed before merging the new one
    // or mergeJson would throw a conflict error.
    expect(() =>
      applyInsertMode(
        makeEntry({ json: { conflicts: 'abort' } }),
        JSON.stringify({ a: 100 }),
        JSON.stringify({ a: 99 }),
        targetPath,
      ),
    ).not.toThrow();
  });

  it('falls back to remove-then-merge when processedText is unparseable JSON', () => {
    const targetPath = path.join(tmpDir, 'file.json');
    // 'a' is first; old contribution was { a: 99 }
    fs.writeFileSync(targetPath, '{\n  "a": 99,\n  "b": 2\n}\n');
    // processedText is invalid JSON → parseJson throws inside the newContrib try/catch
    // → newContrib stays null → old remove-then-merge behaviour applies
    // → 'a' is removed from existingParsed before mergeJson runs
    // mergeJson itself will throw on the invalid processedText, which is expected
    expect(() =>
      applyInsertMode(
        makeEntry({ json: true }),
        'not { valid json',
        JSON.stringify({ a: 99 }),
        targetPath,
      ),
    ).toThrow();
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
      'k1: v1\nk2: v2\n',
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
      'k1: v1\n',
      targetPath,
    );
    expect(result).toContain('k1: custom');
  });
});

// ── YAML — property order preservation ───────────────────────────────────────

describe('YAML — property order preservation', () => {
  it('key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'z: 1\na: 99\nm: 3\n');
    const result = applyInsertMode(
      makeEntry({ yaml: true }),
      'a: 100\n',
      'a: 99\n',
      targetPath,
    );
    expect(result).toBe('z: 1\na: 100\nm: 3\n');
  });

  it('nested key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'config:\n  a: 99\n  userProp: x\n');
    const result = applyInsertMode(
      makeEntry({ yaml: true }),
      'config:\n  a: 100\n',
      'config:\n  a: 99\n',
      targetPath,
    );
    expect(result).toContain('a: 100');
    expect(result).toContain('userProp: x');
    expect(result.indexOf('a: 100')).toBeLessThan(
      result.indexOf('userProp: x'),
    );
  });

  it('uses remove-then-merge (no order preservation) when conflicts: first_wins', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'a: 99\nb: 2\n');
    const result = applyInsertMode(
      makeEntry({ yaml: { conflicts: 'first_wins' } }),
      'a: 100\n',
      'a: 99\n',
      targetPath,
    );
    // first_wins: 'a' is removed then re-merged; no order preservation
    expect(result).toContain('a: 100');
    expect(result.indexOf('b: 2')).toBeLessThan(result.indexOf('a: 100'));
  });

  it('does not throw with conflicts: abort when updated key is removed before merge', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'a: 99\nb: 2\n');
    expect(() =>
      applyInsertMode(
        makeEntry({ yaml: { conflicts: 'abort' } }),
        'a: 100\n',
        'a: 99\n',
        targetPath,
      ),
    ).not.toThrow();
  });

  it('falls back to remove-then-merge when processedText is invalid YAML', () => {
    const targetPath = path.join(tmpDir, 'file.yaml');
    fs.writeFileSync(targetPath, 'a: 99\nb: 2\n');
    // invalid YAML → newContrib stays null → old remove-then-merge behaviour
    // mergeYaml itself will throw on the invalid processedText
    expect(() =>
      applyInsertMode(
        makeEntry({ yaml: true }),
        ': invalid: yaml: [[[',
        'a: 99\n',
        targetPath,
      ),
    ).toThrow();
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
      'k1 = "v1"\nk2 = "v2"\n',
      targetPath,
    );
    expect(result).not.toContain('k1');
    expect(result).toContain('k2');
    expect(result).toContain('userKey');
  });
});

describe('TOML — datetime values', () => {
  it('preserves user datetime values (not incorrectly removed)', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    // User has a datetime value; avanti contributes a string key
    fs.writeFileSync(targetPath, 'created = 2023-01-01T00:00:00Z\nk1 = "v1"\n');
    // lastProcessed only contributed k1; after source removes k1, created must survive
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      '',
      'k1 = "v1"\n',
      targetPath,
    );
    expect(result).toContain('created');
    expect(result).not.toContain('k1');
  });

  it('two different datetimes are not considered equal', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    // User has one datetime; avanti contributed a DIFFERENT datetime
    // deepEqual must return false so the user value is preserved
    fs.writeFileSync(targetPath, 'ts = 2023-12-31T00:00:00Z\n');
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      '',
      'ts = 2023-01-01T00:00:00Z\n',
      targetPath,
    );
    // ts had a different value from what avanti contributed → user override → preserved
    expect(result).toContain('ts');
  });
});
