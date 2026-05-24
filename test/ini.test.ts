import { describe, it, expect } from 'vitest';
import {
  parseIniDoc,
  stringifyIniDoc,
  mergeIni,
  formatIni,
} from '../src/processors/ini';

// ── formatIni ─────────────────────────────────────────────────────────────────

describe('formatIni', () => {
  it('round-trips valid INI', () => {
    const input = '[section]\nkey = value\n';
    const result = formatIni(input);
    const doc = parseIniDoc(result);
    const sec = doc.items.find((it) => it.kind === 'section');
    expect(sec).toBeDefined();
  });

  it('is idempotent', () => {
    const input = '[section]\nkey = value\n';
    expect(formatIni(formatIni(input))).toBe(formatIni(input));
  });

  it('output always ends with newline', () => {
    expect(formatIni('[s]\nk = v')).toMatch(/\n$/);
  });
});

// ── parseIniDoc / stringifyIniDoc round-trips ─────────────────────────────────

describe('parseIniDoc / stringifyIniDoc — round-trips', () => {
  it('preserves comment-only lines', () => {
    const input = '; top comment\nkey = value\n';
    expect(stringifyIniDoc(parseIniDoc(input))).toContain('; top comment');
  });

  it('preserves # comments', () => {
    const input = '# hash comment\nkey = value\n';
    expect(stringifyIniDoc(parseIniDoc(input))).toContain('# hash comment');
  });

  it('preserves blank lines', () => {
    const input = 'a = 1\n\nb = 2\n';
    expect(stringifyIniDoc(parseIniDoc(input))).toContain('\n\n');
  });

  it('preserves section header comments', () => {
    const input = '[section] ; section note\nkey = value\n';
    expect(stringifyIniDoc(parseIniDoc(input))).toContain('; section note');
  });

  it('preserves inline comments on key-value lines', () => {
    const input = '[s]\nkey = value ; inline note\n';
    const output = stringifyIniDoc(parseIniDoc(input));
    expect(output).toContain('; inline note');
  });

  it('handles subsection syntax', () => {
    const input = '[remote "origin"]\nurl = git@github.com\n';
    const output = stringifyIniDoc(parseIniDoc(input));
    expect(output).toContain('[remote "origin"]');
    expect(output).toContain('url');
  });

  it('handles quoted string values', () => {
    const input = '[s]\npath = "/usr/local/bin"\n';
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv');
    expect(kv?.value).toBe('/usr/local/bin');
  });

  it('handles single-quoted string values', () => {
    const input = "[s]\npath = '/usr/local/bin'\n";
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv');
    expect(kv?.value).toBe('/usr/local/bin');
  });

  it('handles backslash continuation', () => {
    const input = 'key = first\\\nsecond\n';
    const doc = parseIniDoc(input);
    const kv = doc.items.find((it) => it.kind === 'kv') as {
      kind: string;
      key: string;
      value: unknown;
    };
    expect(String(kv.value)).toContain('first');
  });

  it('round-trips a value ending with a backslash without treating it as continuation', () => {
    // A trailing backslash must be quoted on serialisation so it is not
    // mis-parsed as a line-continuation marker on the next parse.
    const input = 'path = C:\\tmp\\\n';
    const doc = parseIniDoc(input);
    const serialised = stringifyIniDoc(doc);
    const doc2 = parseIniDoc(serialised);
    const kv = doc2.items.find((it) => it.kind === 'kv') as {
      kind: string;
      key: string;
      value: unknown;
    };
    expect(kv?.key).toBe('path');
    expect(String(kv?.value)).toBe('C:\\tmp\\');
  });

  it('handles boolean coercion (true)', () => {
    const input = '[s]\nenabled = true\n';
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv');
    expect(kv?.value).toBe(true);
  });

  it('handles boolean coercion (false)', () => {
    const input = '[s]\ndebug = false\n';
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv');
    expect(kv?.value).toBe(false);
  });

  it('handles numeric coercion', () => {
    const input = '[s]\nport = 8080\n';
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv');
    expect(kv?.value).toBe(8080);
  });

  it('coalesces key[]=val entries into an array node', () => {
    const input = '[s]\nitem[] = a\nitem[] = b\n';
    const doc = parseIniDoc(input);
    const sec = doc.items.find((it) => it.kind === 'section') as {
      kind: string;
      items: { kind: string; key: string; isArray: boolean; value: unknown }[];
    };
    const kv = sec.items.find((it) => it.kind === 'kv' && it.isArray);
    expect(Array.isArray(kv?.value)).toBe(true);
    expect(kv?.value).toEqual(['a', 'b']);
  });
});

// ── mergeIni — basic ──────────────────────────────────────────────────────────

describe('mergeIni — basic', () => {
  it('returns single source formatted', () => {
    const result = mergeIni(['[s]\nkey = val\n']);
    expect(result).toContain('key');
  });

  it('merges disjoint global keys', () => {
    const result = mergeIni(['a = 1\n', 'b = 2\n']);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('merges disjoint sections', () => {
    const result = mergeIni(['[a]\nx = 1\n', '[b]\ny = 2\n']);
    expect(result).toContain('[a]');
    expect(result).toContain('[b]');
  });
});

// ── mergeIni — conflicts ──────────────────────────────────────────────────────

describe('mergeIni — conflicts (scalars)', () => {
  it('last_wins by default', () => {
    const result = mergeIni(['[s]\nhost = a\n', '[s]\nhost = b\n']);
    expect(result).toContain('host = b');
  });

  it('first_wins keeps first value', () => {
    const result = mergeIni(['[s]\nhost = a\n', '[s]\nhost = b\n'], {
      conflicts: 'first_wins',
    });
    expect(result).toContain('host = a');
    expect(result).not.toContain('host = b');
  });

  it('abort throws on conflicting scalar', () => {
    expect(() =>
      mergeIni(['[s]\nhost = a\n', '[s]\nhost = b\n'], { conflicts: 'abort' }),
    ).toThrow('INI conflict at s.host');
  });

  it('abort does not throw when values are identical', () => {
    expect(() =>
      mergeIni(['[s]\nhost = a\n', '[s]\nhost = a\n'], { conflicts: 'abort' }),
    ).not.toThrow();
  });

  it('reports global key path in abort error', () => {
    expect(() =>
      mergeIni(['a = 1\n', 'a = 2\n'], { conflicts: 'abort' }),
    ).toThrow('INI conflict at a');
  });
});

// ── mergeIni — sections (objects strategy) ────────────────────────────────────

describe('mergeIni — sections (objects strategy)', () => {
  it('deep-merges sections by default', () => {
    const a = '[db]\nhost = a\nport = 5432\n';
    const b = '[db]\nport = 5433\n';
    const result = mergeIni([a, b]);
    expect(result).toContain('host = a');
    expect(result).toContain('port = 5433');
  });

  it('objects:replace overwrites the whole section', () => {
    const a = '[db]\nhost = a\nport = 5432\n';
    const b = '[db]\nport = 5433\n';
    const result = mergeIni([a, b], { objects: 'replace' });
    expect(result).not.toContain('host');
    expect(result).toContain('port = 5433');
  });

  it('reports nested key path in abort error', () => {
    const a = '[db]\nhost = a\n';
    const b = '[db]\nhost = b\n';
    expect(() => mergeIni([a, b], { conflicts: 'abort' })).toThrow(
      'INI conflict at db.host',
    );
  });

  it('appends new section from overlay', () => {
    const result = mergeIni(['[a]\nx = 1\n', '[b]\ny = 2\n']);
    expect(result).toContain('[a]');
    expect(result).toContain('[b]');
  });

  it('handles subsection merge', () => {
    const a = '[remote "origin"]\nurl = git@github.com/a\n';
    const b = '[remote "origin"]\nfetch = +refs/heads/*\n';
    const result = mergeIni([a, b]);
    expect(result).toContain('url');
    expect(result).toContain('fetch');
  });
});

// ── mergeIni — scalar↔array type change ──────────────────────────────────────

describe('mergeIni — scalar↔array type change', () => {
  it('last_wins: overlay array replaces base scalar', () => {
    const result = mergeIni(['[s]\nfoo = 1\n', '[s]\nfoo[] = a\n']);
    expect(result).not.toContain('foo = 1');
    expect(result).toContain('foo[] = a');
  });

  it('last_wins: overlay scalar replaces base array', () => {
    const result = mergeIni(['[s]\nfoo[] = a\n', '[s]\nfoo = 1\n']);
    expect(result).not.toContain('foo[] = a');
    expect(result).toContain('foo = 1');
  });

  it('first_wins: keeps base scalar when overlay is array', () => {
    const result = mergeIni(['[s]\nfoo = 1\n', '[s]\nfoo[] = a\n'], {
      conflicts: 'first_wins',
    });
    expect(result).toContain('foo = 1');
    expect(result).not.toContain('foo[] = a');
  });

  it('abort: throws on scalar↔array type change', () => {
    expect(() =>
      mergeIni(['[s]\nfoo = 1\n', '[s]\nfoo[] = a\n'], { conflicts: 'abort' }),
    ).toThrow('INI conflict at s.foo');
  });
});

// ── mergeIni — arrays (key[]=) ────────────────────────────────────────────────

describe('mergeIni — arrays: replace (default)', () => {
  it('replace overwrites array by default', () => {
    const result = mergeIni([
      '[s]\nitem[] = a\nitem[] = b\n',
      '[s]\nitem[] = c\n',
    ]);
    expect(result).not.toContain('item[] = a');
    expect(result).toContain('item[] = c');
  });
});

describe('mergeIni — arrays: concat', () => {
  it('concat appends arrays', () => {
    const result = mergeIni(
      ['[s]\nitem[] = a\nitem[] = b\n', '[s]\nitem[] = c\n'],
      { arrays: 'concat' },
    );
    expect(result).toContain('item[] = a');
    expect(result).toContain('item[] = b');
    expect(result).toContain('item[] = c');
  });
});

describe('mergeIni — arrays: dedupe', () => {
  it('appends only items not already present', () => {
    const result = mergeIni(
      ['[s]\nitem[] = a\nitem[] = b\n', '[s]\nitem[] = b\nitem[] = c\n'],
      { arrays: 'dedupe' },
    );
    // a and b from base, c new
    const lines = result.split('\n').filter((l) => l.startsWith('item[]'));
    expect(lines).toHaveLength(3);
  });

  it('preserves order: base items first, new items in encounter order', () => {
    const result = mergeIni(
      ['[s]\nitem[] = c\nitem[] = a\n', '[s]\nitem[] = a\nitem[] = b\n'],
      { arrays: 'dedupe' },
    );
    const lines = result.split('\n').filter((l) => l.startsWith('item[]'));
    expect(lines[0]).toContain('c');
    expect(lines[1]).toContain('a');
    expect(lines[2]).toContain('b');
  });

  it('accumulates correctly across three sources', () => {
    const result = mergeIni(
      [
        '[s]\nitem[] = a\n',
        '[s]\nitem[] = b\n',
        '[s]\nitem[] = a\nitem[] = c\n',
      ],
      { arrays: 'dedupe' },
    );
    const lines = result.split('\n').filter((l) => l.startsWith('item[]'));
    expect(lines).toHaveLength(3);
  });
});

// ── mergeIni — three sources ──────────────────────────────────────────────────

describe('mergeIni — three sources', () => {
  it('applies last_wins across all sources', () => {
    const result = mergeIni([
      '[s]\nhost = a\n',
      '[s]\nhost = b\n',
      '[s]\nhost = c\n',
    ]);
    expect(result).toContain('host = c');
  });

  it('first_wins across all sources', () => {
    const result = mergeIni(
      ['[s]\nhost = a\n', '[s]\nhost = b\n', '[s]\nhost = c\n'],
      { conflicts: 'first_wins' },
    );
    expect(result).toContain('host = a');
  });
});

// ── mergeIni — comment preservation ──────────────────────────────────────────

describe('mergeIni — comment preservation', () => {
  it('comments on unchanged keys survive a merge', () => {
    const base = '; db config\n[db]\n; host setting\nhost = a\nport = 5432\n';
    const overlay = '[db]\nport = 5433\n';
    const result = mergeIni([base, overlay]);
    expect(result).toContain('; db config');
    expect(result).toContain('; host setting');
    expect(result).toContain('host = a');
    expect(result).toContain('port = 5433');
  });

  it('inline comment on unchanged key survives a merge', () => {
    const base = '[s]\nkey = value ; keep this\nother = x\n';
    const overlay = '[s]\nother = y\n';
    const result = mergeIni([base, overlay]);
    expect(result).toContain('; keep this');
  });

  it('inline comment survives when own value is updated', () => {
    const base = '[s]\nport = 5432 ; default port\n';
    const overlay = '[s]\nport = 5433\n';
    const result = mergeIni([base, overlay]);
    expect(result).toContain('port = 5433');
    expect(result).toContain('; default port');
  });
});

// ── mergeIni — key order preservation ────────────────────────────────────────

describe('mergeIni — key order preservation', () => {
  it('updated key stays in original position', () => {
    const base = '[s]\nz = 1\na = 99\nm = 3\n';
    const overlay = '[s]\na = 100\n';
    const result = mergeIni([base, overlay]);
    const lines = result.split('\n').filter((l) => /^[zam]/.test(l));
    expect(lines[0]).toMatch(/^z/);
    expect(lines[1]).toMatch(/^a/);
    expect(lines[2]).toMatch(/^m/);
    expect(result).toContain('a = 100');
  });

  it('new key is appended at end of section', () => {
    const base = '[s]\nz = 1\na = 2\n';
    const overlay = '[s]\nnew = 3\n';
    const result = mergeIni([base, overlay]);
    const lines = result.split('\n').filter((l) => /^[zan]/.test(l));
    expect(lines[0]).toMatch(/^z/);
    expect(lines[1]).toMatch(/^a/);
    expect(lines[2]).toMatch(/^new/);
  });
});

// ── trailing newline ──────────────────────────────────────────────────────────

describe('trailing newline', () => {
  it('mergeIni output always ends with newline', () => {
    expect(mergeIni(['[s]\na = 1\n', '[s]\nb = 2\n'])).toMatch(/\n$/);
  });

  it('formatIni output always ends with newline', () => {
    expect(formatIni('[s]\na = 1')).toMatch(/\n$/);
  });
});
