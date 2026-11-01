import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyInsertMode,
  applyInsertModeTracked,
  type InsertHistory,
} from '../src/processors/insert';
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

describe('TOML — property order preservation', () => {
  it('key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, 'z = 1\na = 99\nm = 3\n');
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      'a = 100\n',
      'a = 99\n',
      targetPath,
    );
    // 'a' must stay between 'z' and 'm', not be appended at the end
    const lines = result.trim().split('\n');
    const idxZ = lines.findIndex((l) => l.startsWith('z'));
    const idxA = lines.findIndex((l) => l.startsWith('a'));
    const idxM = lines.findIndex((l) => l.startsWith('m'));
    expect(idxZ).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxM);
    expect(result).toContain('a = 100');
  });

  it('nested key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, '[config]\na = 99\nuserProp = "x"\n');
    const result = applyInsertMode(
      makeEntry({ toml: true }),
      '[config]\na = 100\n',
      '[config]\na = 99\n',
      targetPath,
    );
    expect(result).toContain('a = 100');
    expect(result).toContain('userProp = "x"');
    // 'a' must appear before 'userProp' inside [config]
    const lines = result.trim().split('\n');
    const idxA = lines.findIndex((l) => l.startsWith('a'));
    const idxU = lines.findIndex((l) => l.startsWith('userProp'));
    expect(idxA).toBeLessThan(idxU);
  });

  it('uses remove-then-merge (no order preservation) when conflicts: first_wins', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, 'a = 99\nb = 2\n');
    const result = applyInsertMode(
      makeEntry({ toml: { conflicts: 'first_wins' } }),
      'a = 100\n',
      'a = 99\n',
      targetPath,
    );
    // 'a' is removed then re-merged; new value wins; 'a' appears after 'b'
    const lines = result.trim().split('\n');
    const idxB = lines.findIndex((l) => l.startsWith('b'));
    const idxA = lines.findIndex((l) => l.startsWith('a'));
    expect(idxB).toBeLessThan(idxA);
    expect(result).toContain('a = 100');
  });

  it('does not throw with conflicts: abort when updated key is removed before merge', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    fs.writeFileSync(targetPath, 'a = 99\nb = 2\n');
    const result = applyInsertMode(
      makeEntry({ toml: { conflicts: 'abort' } }),
      'a = 100\n',
      'a = 99\n',
      targetPath,
    );
    expect(result).toContain('a = 100');
    expect(result).toContain('b = 2');
  });

  it('falls back to remove-then-merge when processedText is unparseable TOML', () => {
    const targetPath = path.join(tmpDir, 'file.toml');
    // 'a' is first; old contribution was a = 99
    fs.writeFileSync(targetPath, 'a = 99\nb = 2\n');
    // processedText is invalid TOML → parseToml throws inside the newContrib try/catch
    // → newContrib stays null → old remove-then-merge behaviour applies
    // → mergeToml itself will throw on the invalid processedText, which is expected
    expect(() =>
      applyInsertMode(
        makeEntry({ toml: true }),
        'not valid toml ===',
        'a = 99\n',
        targetPath,
      ),
    ).toThrow();
  });
});

// ── INI — property order preservation ────────────────────────────────────────

describe('INI — property order preservation', () => {
  it('key updated in new contribution keeps its original position', () => {
    const targetPath = path.join(tmpDir, 'file.ini');
    fs.writeFileSync(targetPath, '[s]\nz = 1\na = 99\nm = 3\n');
    const result = applyInsertMode(
      makeEntry({ ini: true, target: 'file.ini' }),
      '[s]\na = 100\n',
      '[s]\na = 99\n',
      targetPath,
    );
    // 'a' must stay between 'z' and 'm', not be appended at the end
    const lines = result.trim().split('\n');
    const idxZ = lines.findIndex((l) => l.startsWith('z'));
    const idxA = lines.findIndex((l) => l.startsWith('a'));
    const idxM = lines.findIndex((l) => l.startsWith('m'));
    expect(idxZ).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxM);
    expect(result).toContain('a = 100');
  });

  it('comment on existing key is preserved after update', () => {
    const targetPath = path.join(tmpDir, 'file.ini');
    fs.writeFileSync(targetPath, '[s]\n; the port\nport = 5432\nhost = x\n');
    const result = applyInsertMode(
      makeEntry({ ini: true, target: 'file.ini' }),
      '[s]\nport = 5433\n',
      '[s]\nport = 5432\n',
      targetPath,
    );
    expect(result).toContain('port = 5433');
    expect(result).toContain('host = x');
    expect(result).toContain('; the port');
  });

  it('uses remove-then-merge (no order preservation) when conflicts: first_wins', () => {
    const targetPath = path.join(tmpDir, 'file.ini');
    fs.writeFileSync(targetPath, '[s]\na = 99\nb = 2\n');
    const result = applyInsertMode(
      makeEntry({ ini: { conflicts: 'first_wins' }, target: 'file.ini' }),
      '[s]\na = 100\n',
      '[s]\na = 99\n',
      targetPath,
    );
    // 'a' is removed then re-merged; 'b' was already present so appears first
    const lines = result
      .trim()
      .split('\n')
      .filter((l) => /^[ab]/.test(l));
    const idxB = lines.findIndex((l) => l.startsWith('b'));
    const idxA = lines.findIndex((l) => l.startsWith('a'));
    expect(idxB).toBeLessThan(idxA);
    expect(result).toContain('a = 100');
  });

  it('does not throw with conflicts: abort when updated key is removed before merge', () => {
    const targetPath = path.join(tmpDir, 'file.ini');
    fs.writeFileSync(targetPath, '[s]\na = 99\nb = 2\n');
    const result = applyInsertMode(
      makeEntry({ ini: { conflicts: 'abort' }, target: 'file.ini' }),
      '[s]\na = 100\n',
      '[s]\na = 99\n',
      targetPath,
    );
    expect(result).toContain('a = 100');
    expect(result).toContain('b = 2');
  });
});

// ── Removal edge cases ───────────────────────────────────────────────────────

function insertInto(
  file: string,
  existing: string,
  overrides: Partial<FileEntry>,
  processed: string,
  last: string | null,
): string {
  const targetPath = path.join(tmpDir, file);
  fs.writeFileSync(targetPath, existing);
  return applyInsertMode(
    makeEntry({ target: file, ...overrides }),
    processed,
    last,
    targetPath,
  );
}

describe('JSON — removal edge cases', () => {
  it('throws when the existing file is not valid JSON', () => {
    expect(() =>
      insertInto('f.json', '{ broken', { json: true }, '{}', '{}'),
    ).toThrow('insert mode: existing file is not valid JSON/JSONC');
  });

  it('removes nested array and object items by deep equality', () => {
    const result = insertInto(
      'f.json',
      JSON.stringify({ arr: [[1, 2], { b: 1, a: 2 }, 'user'] }),
      { json: { arrays: 'concat' } },
      '{}',
      JSON.stringify({ arr: [[1, 2], { a: 2, b: 1 }] }),
    );
    expect(JSON.parse(result)).toEqual({ arr: ['user'] });
  });

  it('removes a scalar that avanti replaced with an array of the same value', () => {
    const result = insertInto(
      'f.json',
      JSON.stringify({ k: [1], user: true }),
      { json: true },
      '{}',
      JSON.stringify({ k: [1] }),
    );
    expect(JSON.parse(result)).toEqual({ user: true });
  });
});

describe('YAML — removal edge cases', () => {
  it('throws when the existing file is not valid YAML', () => {
    expect(() =>
      insertInto('f.yaml', 'a: [unclosed\n', { yaml: true }, 'b: 1\n', 'b: 1'),
    ).toThrow('insert mode: existing file is not valid YAML');
  });

  it('removes a nested map when avanti was the sole contributor', () => {
    const result = insertInto(
      'f.yaml',
      'outer:\n  k: v\nuser: 1\n',
      { yaml: true },
      '{}\n',
      'outer:\n  k: v\n',
    );
    expect(result).toBe('user: 1\n');
  });

  it('removes contributed sequence items', () => {
    const result = insertInto(
      'f.yaml',
      'arr:\n  - mine\n  - a\n  - b\nall:\n  - a\nuser: 1\n',
      { yaml: { arrays: 'concat' } },
      '{}\n',
      'arr: [a, b]\nall: [a]\n',
    );
    expect(result).toBe('arr:\n  - mine\nuser: 1\n');
  });

  it('removes keys whose value node is empty', () => {
    const result = insertInto(
      'f.yaml',
      '? k\nother: 1\n',
      { yaml: true },
      '{}\n',
      'k: null\n',
    );
    expect(result).toBe('other: 1\n');
  });

  it('handles non-scalar keys in the existing document', () => {
    const result = insertInto(
      'f.yaml',
      '? [a, b]\n: complex\nk: v\n',
      { yaml: true },
      'k: w\n',
      'k: v\n',
    );
    expect(result).toContain('k: w');
    expect(result).toContain('complex');
  });
});

describe('TOML — removal edge cases', () => {
  it('throws when the existing file is not valid TOML', () => {
    expect(() =>
      insertInto('f.toml', 'a = [\n', { toml: true }, 'b = 1\n', 'b = 1\n'),
    ).toThrow('insert mode: existing file is not valid TOML');
  });

  it('removes a nested table when avanti was the sole contributor', () => {
    const result = insertInto(
      'f.toml',
      'user = 1\n[outer]\nk = "v"\n',
      { toml: true },
      '',
      '[outer]\nk = "v"\n',
    );
    expect(result.trim()).toBe('user = 1');
  });

  it('removes contributed array items', () => {
    const result = insertInto(
      'f.toml',
      'arr = [0, 1, 2]\nall = [1]\nuser = 1\n',
      { toml: { arrays: 'concat' } },
      '',
      'arr = [1, 2]\nall = [1]\n',
    );
    expect(result.trim()).toBe('arr = [ 0 ]\nuser = 1');
  });
});

describe('INI — removal edge cases', () => {
  it('throws when the existing file is not valid INI', () => {
    expect(() =>
      insertInto('f.ini', '[broken\n', { ini: true }, 'a = 1\n', 'a = 1\n'),
    ).toThrow('insert mode: existing file is not valid INI');
  });

  it('merges without removal on first insert', () => {
    const result = insertInto(
      'f.ini',
      'user = 1\n',
      { ini: true },
      'a = 1\n',
      null,
    );
    expect(result).toBe('user = 1\na = 1\n');
  });

  it('removes global scalars and arrays avanti contributed', () => {
    const result = insertInto(
      'f.ini',
      '; header\ng = 1\nlist[] = a\nlist[] = b\nmine = 2\n[s]\nx = 1\n',
      { ini: true },
      '',
      'g = 1\nlist[] = a\nlist[] = b\nmissing = 1\nnope[] = 1\n',
    );
    expect(result).toBe('; header\nmine = 2\n[s]\nx = 1\n');
  });

  it('updates a global scalar in place', () => {
    const result = insertInto(
      'f.ini',
      'g = 1\nmine = 2\n',
      { ini: true },
      'g = 3\n',
      'g = 1\n',
    );
    expect(result).toBe('g = 3\nmine = 2\n');
  });

  it('keeps global scalars the user changed', () => {
    const result = insertInto('f.ini', 'g = 5\n', { ini: true }, '', 'g = 1\n');
    expect(result).toBe('g = 5\n');
  });

  it('updates a global array in place without leaving a blank line', () => {
    const result = insertInto(
      'f.ini',
      'list[] = a\nmine = 1\n',
      { ini: true },
      'list[] = b\n',
      'list[] = a\n',
    );
    expect(result).toBe('list[] = b\nmine = 1\n');
  });

  it('removes section keys and arrays together with their comments', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nkeep = 1\n; about k\nk = v\n\n; the list\nlist[] = a\nlist[] = b\n',
      { ini: true },
      '',
      '[s]\nk = v\nlist[] = a\nlist[] = b\nmissing[] = 1\n',
    );
    expect(result).toBe('[s]\nkeep = 1\n');
  });

  it('updates a section array in place without leaving a blank line', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nlist[] = a\nmine = 1\n',
      { ini: true },
      '[s]\nlist[] = b\n',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nlist[] = b\nmine = 1\n');
  });

  it.each(['concat', 'dedupe'] as const)(
    'applies an update with repeated sections once (arrays: %s)',
    (arrays) => {
      const result = insertInto(
        'f.ini',
        '[s]\nlist[] = a\nmine = 1\n',
        { ini: { arrays } },
        '[s]\nlist[] = b\n[s]\nlist[] = c\n',
        '[s]\nlist[] = a\n',
      );
      expect(result).toBe('[s]\nlist[] = b\nlist[] = c\nmine = 1\n');
    },
  );

  it.each([true, { arrays: 'concat' as const }])(
    'removes stale array values from an earlier repeated section (%o)',
    (ini) => {
      const result = insertInto(
        'f.ini',
        '[s]\nlist[] = a\n[s]\nx = 1\n',
        { ini },
        '[s]\nlist[] = b\n',
        '[s]\nlist[] = a\n',
      );
      expect(result).toBe('[s]\nx = 1\nlist[] = b\n');
    },
  );

  it('keeps the last repeated section header under first_wins', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nx = 1\n[s]\nlist[] = a\n',
      { ini: { conflicts: 'first_wins' } },
      '[s]\nlist[] = b\n',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nx = 1\n[s]\nlist[] = b\n');
  });

  it('removes array values spread over repeated sections', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nlist[] = a\nmine = 1\n[s]\nlist[] = b\n',
      { ini: true },
      '',
      '[s]\nlist[] = a\nlist[] = b\n',
    );
    expect(result).toBe('[s]\nmine = 1\n');
  });

  it('removes each old array value only once across repeated sections', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nlist[] = a\n[s]\nlist[] = a\n',
      { ini: true },
      '',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nlist[] = a\n');
  });

  it('skips array nodes in later sections that do not hold old values', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nlist[] = a\n[s]\nlist[] = z\n',
      { ini: true },
      '',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nlist[] = z\n');
  });

  it('removes an empty section avanti contributed', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nmine = 1\n[t]\n',
      { ini: true },
      '',
      '[t]\n',
    );
    expect(result).toBe('[s]\nmine = 1\n');
  });

  it('removes a stale scalar from an earlier repeated section', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nk = v\n[s]\nx = 1\n',
      { ini: true },
      '',
      '[s]\nk = v\n',
    );
    expect(result).toBe('[s]\nx = 1\n');
  });

  it('moves an updated scalar from an earlier repeated section to the last one', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nk = v\n[s]\nx = 1\n',
      { ini: true },
      '[s]\nk = w\n',
      '[s]\nk = v\n',
    );
    expect(result).toBe('[s]\nx = 1\nk = w\n');
  });

  it('removes all values of an old contribution with repeated sections', () => {
    const result = insertInto(
      'f.ini',
      '[s]\na = 1\nlist[] = x\n[s]\nb = 2\nlist[] = y\nmine = 3\n',
      { ini: { arrays: 'concat' } },
      '',
      '[s]\na = 1\nlist[] = x\n[s]\nb = 2\nlist[] = y\n',
    );
    expect(result).toBe('[s]\nmine = 3\n');
  });

  it('removes only the array values a repeated-section contribution wrote (arrays: replace)', () => {
    // Under arrays: replace only `b` was written; the earlier `a` is the user's.
    const targetPath = path.join(tmpDir, 'f.ini');
    fs.writeFileSync(targetPath, '[s]\nlist[] = a\n[s]\nx = 1\n');
    const entry = makeEntry({ ini: true, target: 'f.ini' });
    const contrib = '[s]\nlist[] = a\n[s]\nlist[] = b\n';
    const written = applyInsertMode(entry, contrib, null, targetPath);
    expect(written).toBe('[s]\nlist[] = a\n[s]\nx = 1\nlist[] = b\n');
    fs.writeFileSync(targetPath, written);
    expect(applyInsertMode(entry, '', contrib, targetPath)).toBe(
      '[s]\nlist[] = a\n[s]\nx = 1\n',
    );
  });

  it.each(['first_wins', 'abort'] as const)(
    'updates a section with objects: replace (conflicts: %s)',
    (conflicts) => {
      const result = insertInto(
        'f.ini',
        '[s]\nk = v\n',
        { ini: { objects: 'replace', conflicts } },
        '[s]\nk = w\n',
        '[s]\nk = v\n',
      );
      expect(result).toBe('[s]\nk = w\n');
    },
  );

  it('ignores comments in the new contribution', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nx = 1\n[s]\nlist[] = a\n',
      { ini: { conflicts: 'first_wins' } },
      '; top\n[s]\n; about list\nlist[] = b\n',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nx = 1\n[s]\nlist[] = b\n');
  });

  it('keeps a repeated section it removed nothing from', () => {
    const result = insertInto(
      'f.ini',
      '[s]\n; note\n[s]\nk = v\n',
      { ini: true },
      '',
      '[s]\nk = v\n',
    );
    expect(result).toBe('[s]\n; note\n');
  });

  it('keeps a user override in a later repeated section', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nk = v\n[s]\nk = mine\n',
      { ini: true },
      '',
      '[s]\nk = v\n',
    );
    expect(result).toBe('[s]\nk = v\n[s]\nk = mine\n');
  });

  it('updates an array repeatedly without accumulating blank lines', () => {
    const targetPath = path.join(tmpDir, 'f.ini');
    fs.writeFileSync(targetPath, '[s]\nlist[] = a\n');
    const entry = makeEntry({ ini: true, target: 'f.ini' });
    let last = '[s]\nlist[] = a\n';
    for (const v of ['b', 'c', 'd']) {
      const next = `[s]\nlist[] = ${v}\n`;
      fs.writeFileSync(
        targetPath,
        applyInsertMode(entry, next, last, targetPath),
      );
      last = next;
    }
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('[s]\nlist[] = d\n');
  });

  it('removes a subsection avanti contributed and keeps others', () => {
    const result = insertInto(
      'f.ini',
      '[remote "o"]\nurl = a\n[remote "p"]\nurl = b\n',
      { ini: true },
      '',
      '[remote "o"]\nurl = a\n',
    );
    expect(result).toBe('[remote "p"]\nurl = b\n');
  });

  it('keeps a subsection that still has user keys', () => {
    const result = insertInto(
      'f.ini',
      '[remote "o"]\nurl = a\nuser = 1\n',
      { ini: true },
      '',
      '[remote "o"]\nurl = a\n',
    );
    expect(result).toBe('[remote "o"]\nuser = 1\n');
  });
});

describe('insert — previous contribution no longer matches the file', () => {
  it('JSON: skips keys the user already deleted', () => {
    const result = insertInto(
      'f.json',
      JSON.stringify({ user: 1 }),
      { json: true },
      '{}',
      JSON.stringify({ gone: 1 }),
    );
    expect(JSON.parse(result)).toEqual({ user: 1 });
  });

  it('JSON: skips removal when the previous contribution is not an object', () => {
    const result = insertInto(
      'f.json',
      JSON.stringify({ a: 1 }),
      { json: true },
      JSON.stringify({ b: 2 }),
      '[1]',
    );
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it('YAML: skips keys the user already deleted', () => {
    const result = insertInto(
      'f.yaml',
      'user: 1\n',
      { yaml: true },
      'a: 2\n',
      'gone: 1\n',
    );
    expect(result).toBe('user: 1\na: 2\n');
  });

  it('YAML: skips removal when the existing file is not a map', () => {
    const result = insertInto(
      'f.yaml',
      '- a\n',
      { yaml: true },
      '- b\n',
      'x: 1\n',
    );
    expect(result).toBe('- b\n');
  });

  it('YAML: skips removal when the previous contribution is invalid YAML', () => {
    const result = insertInto(
      'f.yaml',
      'a: 1\nuser: 2\n',
      { yaml: true },
      'a: 3\n',
      'a: [unclosed\n',
    );
    expect(result).toBe('a: 3\nuser: 2\n');
  });

  it('YAML: skips removal when the previous contribution is not a map', () => {
    const result = insertInto(
      'f.yaml',
      'a: 1\n',
      { yaml: true },
      'b: 2\n',
      '- a\n',
    );
    expect(result).toBe('a: 1\nb: 2\n');
  });

  it('TOML: skips keys the user already deleted', () => {
    const result = insertInto(
      'f.toml',
      'user = 1\n',
      { toml: true },
      '',
      'gone = 1\n',
    );
    expect(result.trim()).toBe('user = 1');
  });

  it('INI: keeps array items the user added to a section array', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nlist[] = a\nlist[] = user\n',
      { ini: true },
      '',
      '[s]\nlist[] = a\n',
    );
    expect(result).toBe('[s]\nlist[] = user\n');
  });

  it('INI: keeps array items the user added to a global array', () => {
    const result = insertInto(
      'f.ini',
      'list[] = a\nlist[] = user\n',
      { ini: true },
      '',
      'list[] = a\n',
    );
    expect(result).toBe('list[] = user\n');
  });

  it('INI: skips section keys the user deleted or changed', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nk = 5\n',
      { ini: true },
      '',
      '[s]\ngone = 1\nk = 1\n',
    );
    expect(result).toBe('[s]\nk = 5\n');
  });

  it('INI: skips sections the user deleted and leaves other sections alone', () => {
    const result = insertInto(
      'f.ini',
      'top = 1\n[a]\nx = 1\n[b]\ny = 1\n',
      { ini: true },
      '',
      '[a]\nx = 1\n[c]\nz = 1\n',
    );
    expect(result).toBe('top = 1\n[b]\ny = 1\n');
  });

  it('INI: ignores comments in the previous contribution', () => {
    const result = insertInto(
      'f.ini',
      '[s]\nk = v\nuser = 1\n',
      { ini: true },
      '',
      '; c\n[s]\n; d\nk = v\n',
    );
    expect(result).toBe('[s]\nuser = 1\n');
  });
});

describe('INI — ownership tracking', () => {
  // Runs inserts one after another, passing each result's ownership to the
  // next one the way pull stores it in history. Returns the file after each.
  function iniSteps(
    existing: string | null,
    ini: FileEntry['ini'],
    steps: string[],
  ): { texts: string[]; owned: unknown[] } {
    const targetPath = path.join(tmpDir, 'f.ini');
    if (existing !== null) fs.writeFileSync(targetPath, existing);
    const entry = makeEntry({ target: 'f.ini', ini });
    const texts: string[] = [];
    const owned: unknown[] = [];
    let last: InsertHistory | null = null;
    for (const processed of steps) {
      const result = applyInsertModeTracked(entry, processed, last, targetPath);
      fs.writeFileSync(targetPath, result.text);
      texts.push(result.text);
      owned.push(result.owned);
      last = { processed, owned: result.owned };
    }
    return { texts, owned };
  }

  // Removes the previous contribution from `file`, given its ownership.
  function removeWith(file: string, processed: string, owned: unknown): string {
    const targetPath = path.join(tmpDir, 'f.ini');
    fs.writeFileSync(targetPath, file);
    return applyInsertModeTracked(
      makeEntry({ target: 'f.ini', ini: true }),
      '',
      { processed, owned },
      targetPath,
    ).text;
  }

  it('keeps user arrays when first_wins rejected the contributed one', () => {
    const { texts } = iniSteps(
      '[s]\nlist[] = a\n[s]\nlist[] = b\n',
      { conflicts: 'first_wins' },
      ['[s]\nlist[] = a\nowned = 1\n', ''],
    );
    expect(texts).toEqual([
      '[s]\nlist[] = a\n[s]\nlist[] = b\nowned = 1\n',
      '[s]\nlist[] = a\n[s]\nlist[] = b\n',
    ]);
  });

  it.each(['first_wins', 'abort'] as const)(
    'removes all repeated sections written to a missing target (%s)',
    (conflicts) => {
      const { texts, owned } = iniSteps(null, { conflicts }, [
        '[s]\nk = a\n[s]\nk = b\n',
        '',
      ]);
      expect(texts).toEqual(['[s]\nk = a\n[s]\nk = b\n', '\n']);
      expect(owned[0]).toEqual({
        format: 'ini',
        globals: [],
        sections: [
          {
            name: 's',
            index: 0,
            created: true,
            kvs: [{ key: 'k', isArray: false, value: 'a' }],
          },
          {
            name: 's',
            index: 1,
            created: true,
            kvs: [{ key: 'k', isArray: false, value: 'b' }],
          },
        ],
      });
    },
  );

  it('keeps the user array item a concat contribution repeated', () => {
    const { texts, owned } = iniSteps(
      '[s]\nlist[] = a\n',
      { arrays: 'concat' },
      ['[s]\nlist[] = a\n[s]\nlist[] = b\n', ''],
    );
    expect(texts).toEqual([
      '[s]\nlist[] = a\nlist[] = b\n',
      '[s]\nlist[] = a\n',
    ]);
    expect(owned[0]).toEqual({
      format: 'ini',
      globals: [],
      sections: [
        {
          name: 's',
          index: 0,
          created: false,
          kvs: [{ key: 'list', isArray: true, value: ['b'] }],
        },
      ],
    });
  });

  it('owns nothing when the file already had the contribution', () => {
    const { texts, owned } = iniSteps('k = v\n[s]\nlist[] = a\n', true, [
      'k = v\n[s]\nlist[] = a\n',
      '',
    ]);
    expect(owned[0]).toEqual({ format: 'ini', globals: [], sections: [] });
    expect(texts[1]).toBe('k = v\n[s]\nlist[] = a\n');
  });

  it('still owns values an update repeats unchanged', () => {
    const { texts } = iniSteps('u = 1\n', true, [
      'k = v\n[s]\nx = 1\n',
      'k = v\n[s]\nx = 1\n',
      '',
    ]);
    expect(texts).toEqual([
      'u = 1\nk = v\n[s]\nx = 1\n',
      'u = 1\nk = v\n[s]\nx = 1\n',
      'u = 1\n',
    ]);
  });

  it('updates owned values in place and then removes them', () => {
    const { texts } = iniSteps('u = 1\n', true, [
      'k = v\nl[] = a\n[s]\nx = 1\n',
      'k = w\nl[] = b\n[s]\ny = 2\n',
      '',
    ]);
    expect(texts).toEqual([
      'u = 1\nk = v\nl[] = a\n[s]\nx = 1\n',
      'u = 1\nk = w\nl[] = b\n[s]\ny = 2\n',
      'u = 1\n',
    ]);
  });

  it('keeps a user section header after removing values added to it', () => {
    const { texts } = iniSteps('[s]\n', true, ['[s]\nx = 1\n', '']);
    expect(texts).toEqual(['[s]\nx = 1\n', '[s]\n']);
  });

  it('removes a created empty section', () => {
    const { texts } = iniSteps('u = 1\n', true, ['[s]\n', '']);
    expect(texts).toEqual(['u = 1\n[s]\n', 'u = 1\n']);
  });

  it('owns a value whose type changed', () => {
    const { texts } = iniSteps('k = 1\nu = 1\n', true, ['k[] = a\n', '']);
    expect(texts).toEqual(['k[] = a\nu = 1\n', 'u = 1\n']);
  });

  it('owns a value it changed', () => {
    const { texts } = iniSteps('k = 1\nu = 1\n', true, ['k = 2\n', '']);
    expect(texts).toEqual(['k = 2\nu = 1\n', 'u = 1\n']);
  });

  it('owns all items of an array key repeated in the contribution', () => {
    const { texts } = iniSteps(null, true, [
      '[s]\nl[] = a\nx = 1\nl[] = b\n',
      '',
    ]);
    expect(texts[1]).toBe('\n');
  });

  it('owns the new value when the user changed an owned one', () => {
    const targetPath = path.join(tmpDir, 'f.ini');
    const entry = makeEntry({ target: 'f.ini', ini: true });
    const processed = 'k = 1\n[s]\nx = 1\n';
    const first = applyInsertModeTracked(entry, processed, null, targetPath);
    fs.writeFileSync(targetPath, 'k = 5\n[s]\nx = 5\n');
    const second = applyInsertModeTracked(
      entry,
      'k = 2\n[s]\nx = 2\n',
      { processed, owned: first.owned },
      targetPath,
    );
    expect(second.text).toBe('k = 2\n[s]\nx = 2\n');
    expect(removeWith(second.text, 'k = 2\n[s]\nx = 2\n', second.owned)).toBe(
      '\n',
    );
  });

  it('owns subsections', () => {
    const { texts } = iniSteps('u = 1\n', true, ['[s "x"]\nk = v\n', '']);
    expect(texts).toEqual(['u = 1\n[s "x"]\nk = v\n', 'u = 1\n']);
  });

  it('falls back to the last section when an owned one was removed by hand', () => {
    const processed = '[s]\nk = a\n[s]\nk = b\n';
    const { owned } = iniSteps(null, true, [processed]);
    expect(removeWith('[s]\nk = a\n', processed, owned[0])).toBe('\n');
  });

  it('skips owned sections that no longer exist', () => {
    const processed = '[s]\nk = v\n';
    const { owned } = iniSteps('u = 1\n', true, [processed]);
    expect(removeWith('u = 1\n', processed, owned[0])).toBe('u = 1\n');
  });

  it('owns nothing for a missing target that is not valid INI', () => {
    const result = applyInsertModeTracked(
      makeEntry({ target: 'f.ini', ini: true }),
      '[broken\n',
      null,
      path.join(tmpDir, 'f.ini'),
    );
    expect(result).toEqual({ text: '[broken\n', owned: undefined });
  });

  it('tracks no ownership for other formats', () => {
    const result = applyInsertModeTracked(
      makeEntry({ target: 'f.json', json: true }),
      '{"a": 1}',
      null,
      path.join(tmpDir, 'f.json'),
    );
    expect(result).toEqual({ text: '{"a": 1}' });
  });

  const section = { name: 's', index: 0, created: true, kvs: [] };
  it.each([
    ['not an object', 'x'],
    ['wrong format', { format: 'json', globals: [], sections: [] }],
    ['bad globals', { format: 'ini', globals: 'x', sections: [] }],
    ['bad global kv', { format: 'ini', globals: [{ key: 'k' }], sections: [] }],
    [
      'array kv without array value',
      {
        format: 'ini',
        globals: [{ key: 'k', isArray: true, value: 'v' }],
        sections: [],
      },
    ],
    [
      'scalar kv without value',
      { format: 'ini', globals: [{ key: 'k', isArray: false }], sections: [] },
    ],
    ['bad sections', { format: 'ini', globals: [], sections: 'x' }],
    [
      'bad subName',
      { format: 'ini', globals: [], sections: [{ ...section, subName: 1 }] },
    ],
    [
      'bad section kvs',
      { format: 'ini', globals: [], sections: [{ ...section, kvs: 'x' }] },
    ],
  ])(
    'falls back to the fragment when ownership is invalid (%s)',
    (_, owned) => {
      expect(removeWith('k = v\nu = 1\n', 'k = v\n', owned)).toBe('u = 1\n');
    },
  );
});
