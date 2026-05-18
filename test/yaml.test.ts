import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { mergeYaml, formatYaml } from '../src/processors/yaml';

describe('formatYaml', () => {
  it('is idempotent on already-formatted YAML', () => {
    const input = 'a: 1\nb: 2\n';
    expect(formatYaml(input)).toBe(input);
  });

  it('throws on invalid YAML', () => {
    expect(() => formatYaml('key: [unclosed')).toThrow('invalid YAML');
  });

  it('preserves line comments', () => {
    const input = '# server config\nhost: localhost\n';
    expect(formatYaml(input)).toBe(input);
  });

  it('preserves inline comments', () => {
    const input = 'port: 5432 # default postgres port\n';
    expect(formatYaml(input)).toBe(input);
  });
});

describe('mergeYaml — basic', () => {
  it('returns single source unchanged', () => {
    expect(mergeYaml(['a: 1\n'])).toBe('a: 1\n');
  });

  it('merges disjoint keys', () => {
    const result = parseDocument(
      mergeYaml(['a: 1\n', 'b: 2\n']),
    ).toJSON() as unknown;
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('throws on invalid YAML in source', () => {
    expect(() => mergeYaml(['a: 1\n', 'key: [unclosed'])).toThrow(
      '[source 1]: invalid YAML',
    );
  });

  it('returns empty string for empty parts', () => {
    expect(mergeYaml([])).toBe('');
  });
});

describe('mergeYaml — conflicts (scalars)', () => {
  it('last_wins by default', () => {
    const result = parseDocument(mergeYaml(['a: 1\n', 'a: 2\n'])).toJSON() as {
      a: number;
    };
    expect(result.a).toBe(2);
  });

  it('first_wins keeps first value', () => {
    const result = parseDocument(
      mergeYaml(['a: 1\n', 'a: 2\n'], { conflicts: 'first_wins' }),
    ).toJSON() as { a: number };
    expect(result.a).toBe(1);
  });

  it('abort throws on conflicting scalar', () => {
    expect(() =>
      mergeYaml(['a: 1\n', 'a: 2\n'], { conflicts: 'abort' }),
    ).toThrow('YAML conflict at a');
  });

  it('abort does not throw when values are identical', () => {
    expect(() =>
      mergeYaml(['a: 1\n', 'a: 1\n'], { conflicts: 'abort' }),
    ).not.toThrow();
  });
});

describe('mergeYaml — objects', () => {
  it('deep-merges nested objects by default', () => {
    const result = parseDocument(
      mergeYaml(['db:\n  host: a\n  port: 5432\n', 'db:\n  port: 5433\n']),
    ).toJSON() as unknown;
    expect(result).toEqual({ db: { host: 'a', port: 5433 } });
  });

  it('objects:replace overwrites the whole object', () => {
    const result = parseDocument(
      mergeYaml(['db:\n  host: a\n  port: 5432\n', 'db:\n  port: 5433\n'], {
        objects: 'replace',
      }),
    ).toJSON() as unknown;
    expect(result).toEqual({ db: { port: 5433 } });
  });

  it('reports nested key path in abort error', () => {
    expect(() =>
      mergeYaml(['db:\n  host: a\n', 'db:\n  host: b\n'], {
        conflicts: 'abort',
      }),
    ).toThrow('YAML conflict at db.host');
  });
});

describe('mergeYaml — arrays', () => {
  it('replace overwrites array by default', () => {
    const result = parseDocument(
      mergeYaml(['x:\n  - 1\n  - 2\n', 'x:\n  - 3\n  - 4\n']),
    ).toJSON() as { x: number[] };
    expect(result.x).toEqual([3, 4]);
  });

  it('concat appends arrays', () => {
    const result = parseDocument(
      mergeYaml(['x:\n  - 1\n  - 2\n', 'x:\n  - 3\n  - 4\n'], {
        arrays: 'concat',
      }),
    ).toJSON() as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4]);
  });

  it('abort throws on conflicting arrays when arrays:replace', () => {
    expect(() =>
      mergeYaml(['x:\n  - 1\n', 'x:\n  - 2\n'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).toThrow('YAML conflict at x');
  });

  it('abort does not throw on identical arrays', () => {
    expect(() =>
      mergeYaml(['x:\n  - 1\n  - 2\n', 'x:\n  - 1\n  - 2\n'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).not.toThrow();
  });
});

describe('mergeYaml — comment preservation', () => {
  it('preserves leading comment from first source', () => {
    const a = '# server\nhost: a\n';
    const b = 'port: 8080\n';
    const result = mergeYaml([a, b]);
    expect(result).toContain('# server');
    expect(parseDocument(result).toJSON() as unknown).toEqual({
      host: 'a',
      port: 8080,
    });
  });

  it('preserves comments from both sources', () => {
    const a = '# from a\na: 1\n';
    const b = '# from b\nb: 2\n';
    const result = mergeYaml([a, b]);
    expect(result).toContain('# from a');
    expect(result).toContain('# from b');
  });

  it('preserves inline comments', () => {
    const a = 'host: localhost # default\n';
    const b = 'port: 5432\n';
    const result = mergeYaml([a, b]);
    expect(result).toContain('# default');
  });
});

describe('mergeYaml — three sources', () => {
  it('applies last_wins across all sources', () => {
    const result = parseDocument(
      mergeYaml(['a: 1\n', 'a: 2\n', 'a: 3\n']),
    ).toJSON() as { a: number };
    expect(result.a).toBe(3);
  });

  it('first_wins across all sources', () => {
    const result = parseDocument(
      mergeYaml(['a: 1\n', 'a: 2\n', 'a: 3\n'], { conflicts: 'first_wins' }),
    ).toJSON() as { a: number };
    expect(result.a).toBe(1);
  });
});

describe('trailing newline', () => {
  it('mergeYaml output always ends with newline', () => {
    expect(mergeYaml(['a: 1\n', 'b: 2\n'])).toMatch(/\n$/);
  });

  it('formatYaml output always ends with newline', () => {
    expect(formatYaml('a: 1')).toMatch(/\n$/);
  });
});
