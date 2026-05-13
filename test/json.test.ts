import { describe, it, expect } from 'vitest';
import { parse } from 'comment-json';
import { mergeJson, formatJson } from '../src/processors/json';

describe('formatJson', () => {
  it('pretty-prints compact JSON', () => {
    expect(formatJson('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('is idempotent on already-formatted JSON', () => {
    const pretty = '{\n  "a": 1\n}';
    expect(formatJson(pretty)).toBe(pretty);
  });

  it('throws on invalid JSON', () => {
    expect(() => formatJson('{bad}')).toThrow('invalid JSON');
  });
});

describe('mergeJson — basic', () => {
  it('returns single source formatted', () => {
    expect(mergeJson(['{"a":1}'])).toBe('{\n  "a": 1\n}');
  });

  it('merges disjoint keys', () => {
    const result = JSON.parse(mergeJson(['{"a":1}', '{"b":2}'])) as unknown;
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('throws on invalid JSON in source', () => {
    expect(() => mergeJson(['{"a":1}', '{bad}'])).toThrow(
      '[source 1]: invalid JSON',
    );
  });
});

describe('mergeJson — conflicts (scalars)', () => {
  it('last_wins by default', () => {
    const result = JSON.parse(mergeJson(['{"a":1}', '{"a":2}'])) as {
      a: number;
    };
    expect(result.a).toBe(2);
  });

  it('first_wins keeps first value', () => {
    const result = JSON.parse(
      mergeJson(['{"a":1}', '{"a":2}'], { conflicts: 'first_wins' }),
    ) as { a: number };
    expect(result.a).toBe(1);
  });

  it('abort throws on conflicting scalar', () => {
    expect(() =>
      mergeJson(['{"a":1}', '{"a":2}'], { conflicts: 'abort' }),
    ).toThrow('JSON conflict at a');
  });

  it('abort does not throw when values are identical', () => {
    expect(() =>
      mergeJson(['{"a":1}', '{"a":1}'], { conflicts: 'abort' }),
    ).not.toThrow();
  });
});

describe('mergeJson — objects', () => {
  it('deep-merges nested objects by default', () => {
    const result = JSON.parse(
      mergeJson(['{"db":{"host":"a","port":5432}}', '{"db":{"port":5433}}']),
    ) as unknown;
    expect(result).toEqual({ db: { host: 'a', port: 5433 } });
  });

  it('objects:replace overwrites the whole object', () => {
    const result = JSON.parse(
      mergeJson(['{"db":{"host":"a","port":5432}}', '{"db":{"port":5433}}'], {
        objects: 'replace',
      }),
    ) as unknown;
    expect(result).toEqual({ db: { port: 5433 } });
  });

  it('reports nested key path in abort error', () => {
    expect(() =>
      mergeJson(['{"db":{"host":"a"}}', '{"db":{"host":"b"}}'], {
        conflicts: 'abort',
      }),
    ).toThrow('JSON conflict at db.host');
  });
});

describe('mergeJson — arrays', () => {
  it('replace overwrites array by default', () => {
    const result = JSON.parse(mergeJson(['{"x":[1,2]}', '{"x":[3,4]}'])) as {
      x: number[];
    };
    expect(result.x).toEqual([3, 4]);
  });

  it('concat appends arrays', () => {
    const result = JSON.parse(
      mergeJson(['{"x":[1,2]}', '{"x":[3,4]}'], { arrays: 'concat' }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4]);
  });

  it('abort throws on conflicting arrays when arrays:replace', () => {
    expect(() =>
      mergeJson(['{"x":[1]}', '{"x":[2]}'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).toThrow('JSON conflict at x');
  });

  it('abort does not throw on identical arrays', () => {
    expect(() =>
      mergeJson(['{"x":[1,2]}', '{"x":[1,2]}'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).not.toThrow();
  });
});

describe('formatJson — JSONC', () => {
  it('preserves line comments', () => {
    const input = '{\n  // server host\n  "host": "localhost"\n}';
    expect(formatJson(input)).toBe(input);
  });

  it('preserves block comments', () => {
    const input = '{\n  /* db config */\n  "port": 5432\n}';
    expect(formatJson(input)).toBe(input);
  });

  it('preserves inline trailing comments', () => {
    const input = '{\n  "debug": true // enable debug\n}';
    expect(formatJson(input)).toBe(input);
  });
});

describe('mergeJson — JSONC', () => {
  it('handles sources with line comments', () => {
    const a = '{\n  // server\n  "host": "a"\n}';
    const b = '{"port": 8080}';
    const result = mergeJson([a, b]);
    expect(parse(result)).toEqual({ host: 'a', port: 8080 });
    expect(result).toContain('// server');
  });

  it('preserves comments from both sources in correct order', () => {
    const a = '{\n  // from a\n  "a": 1\n}';
    const b = '{\n  // from b\n  "b": 2\n}';
    const result = mergeJson([a, b]);
    expect(result).toBe('{\n  // from a\n  "a": 1,\n  // from b\n  "b": 2\n}');
  });
});

describe('formatJson — indent', () => {
  it('uses 4 spaces when indent:4', () => {
    expect(formatJson('{"a":1}', { indent: 4 })).toBe('{\n    "a": 1\n}');
  });

  it('uses tab when indent:"tab"', () => {
    expect(formatJson('{"a":1}', { indent: 'tab' })).toBe('{\n\t"a": 1\n}');
  });

  it('defaults to 2 spaces when no indent option', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});

describe('formatJson — trailing_commas', () => {
  it('adds trailing comma on last array element', () => {
    expect(formatJson('[1,2,3]', { trailingCommas: true })).toBe(
      '[\n  1,\n  2,\n  3,\n]',
    );
  });

  it('adds trailing comma on last object property', () => {
    expect(formatJson('{"a":1,"b":2}', { trailingCommas: true })).toBe(
      '{\n  "a": 1,\n  "b": 2,\n}',
    );
  });

  it('adds trailing comma on nested closing braces', () => {
    const result = formatJson('{"a":{"x":1},"b":2}', { trailingCommas: true });
    expect(result).toBe('{\n  "a": {\n    "x": 1,\n  },\n  "b": 2,\n}');
  });

  it('inserts trailing comma before inline // comment', () => {
    const input = '{\n  "debug": true // enable debug\n}';
    expect(formatJson(input, { trailingCommas: true })).toBe(
      '{\n  "debug": true, // enable debug\n}',
    );
  });

  it('adds trailing comma when last element is followed by a comment before }', () => {
    const input = '{\n  "a": 1\n  // end\n}';
    expect(formatJson(input, { trailingCommas: true })).toBe(
      '{\n  "a": 1,\n  // end\n}',
    );
  });

  it('does not double-comma already-trailing-comma lines', () => {
    const already = '{\n  "a": 1,\n  "b": 2\n}';
    const result = formatJson(already, { trailingCommas: true });
    expect(result).toBe('{\n  "a": 1,\n  "b": 2,\n}');
  });
});

describe('formatJson — sort_keys', () => {
  it('sorts object keys alphabetically', () => {
    expect(formatJson('{"z":3,"a":1,"m":2}', { sortKeys: true })).toBe(
      '{\n  "a": 1,\n  "m": 2,\n  "z": 3\n}',
    );
  });

  it('sorts nested object keys recursively', () => {
    const result = JSON.parse(
      formatJson('{"b":{"z":1,"a":2},"a":0}', { sortKeys: true }),
    ) as unknown;
    expect(Object.keys(result as Record<string, unknown>)).toEqual(['a', 'b']);
    expect(
      Object.keys((result as Record<string, Record<string, unknown>>)['b']),
    ).toEqual(['a', 'z']);
  });

  it('leaves arrays unchanged', () => {
    expect(formatJson('[3,1,2]', { sortKeys: true })).toBe(
      '[\n  3,\n  1,\n  2\n]',
    );
  });
});

describe('formatJson — minify', () => {
  it('produces compact single-line output', () => {
    expect(formatJson('{"a":1,"b":2}', { minify: true })).toBe('{"a":1,"b":2}');
  });

  it('strips comments when minify:true', () => {
    const input = '{\n  // comment\n  "a": 1\n}';
    expect(formatJson(input, { minify: true })).toBe('{"a":1}');
  });

  it('ignores trailing_commas when minify:true', () => {
    expect(formatJson('{"a":1}', { minify: true, trailingCommas: true })).toBe(
      '{"a":1}',
    );
  });
});

describe('formatJson — strip_comments', () => {
  it('removes line comments from output', () => {
    const input = '{\n  // comment\n  "a": 1\n}';
    expect(formatJson(input, { stripComments: true })).toBe('{\n  "a": 1\n}');
  });

  it('removes block comments from output', () => {
    const input = '{\n  /* db config */\n  "port": 5432\n}';
    expect(formatJson(input, { stripComments: true })).toBe(
      '{\n  "port": 5432\n}',
    );
  });

  it('respects indent > 10 (not capped like JSON.stringify)', () => {
    const input = '{\n  // comment\n  "a": 1\n}';
    const result = formatJson(input, { stripComments: true, indent: 12 });
    expect(result).toBe('{\n            "a": 1\n}');
  });
});

describe('formatJson — combined options', () => {
  it('sort_keys + trailing_commas + indent:tab', () => {
    const result = formatJson('{"z":3,"a":1}', {
      sortKeys: true,
      trailingCommas: true,
      indent: 'tab',
    });
    expect(result).toBe('{\n\t"a": 1,\n\t"z": 3,\n}');
  });
});

describe('mergeJson — formatting options', () => {
  it('indent:4 applies to merged output', () => {
    const result = mergeJson(['{"a":1}', '{"b":2}'], { indent: 4 });
    expect(result).toBe('{\n    "a": 1,\n    "b": 2\n}');
  });

  it('indent:"tab" applies to merged output', () => {
    const result = mergeJson(['{"a":1}', '{"b":2}'], { indent: 'tab' });
    expect(result).toBe('{\n\t"a": 1,\n\t"b": 2\n}');
  });

  it('trailing_commas applies to merged output', () => {
    const result = mergeJson(['{"a":1}', '{"b":2}'], { trailingCommas: true });
    expect(result).toBe('{\n  "a": 1,\n  "b": 2,\n}');
  });

  it('sort_keys applies after merge', () => {
    const result = mergeJson(['{"z":3}', '{"a":1}'], { sortKeys: true });
    expect(result).toBe('{\n  "a": 1,\n  "z": 3\n}');
  });

  it('minify applies to merged output', () => {
    const result = mergeJson(['{"a":1}', '{"b":2}'], { minify: true });
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('strip_comments applies to merged output', () => {
    const a = '{\n  // comment\n  "a": 1\n}';
    const b = '{"b": 2}';
    const result = mergeJson([a, b], { stripComments: true });
    expect(result).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('sort_keys + trailing_commas + indent applied together', () => {
    const result = mergeJson(['{"z":3}', '{"a":1}'], {
      sortKeys: true,
      trailingCommas: true,
      indent: 4,
    });
    expect(result).toBe('{\n    "a": 1,\n    "z": 3,\n}');
  });
});

describe('mergeJson — three sources', () => {
  it('applies last_wins across all sources', () => {
    const result = JSON.parse(mergeJson(['{"a":1}', '{"a":2}', '{"a":3}'])) as {
      a: number;
    };
    expect(result.a).toBe(3);
  });

  it('first_wins across all sources', () => {
    const result = JSON.parse(
      mergeJson(['{"a":1}', '{"a":2}', '{"a":3}'], {
        conflicts: 'first_wins',
      }),
    ) as { a: number };
    expect(result.a).toBe(1);
  });
});
