import { describe, it, expect } from 'vitest';
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
    const result = JSON.parse(mergeJson(['{"a":1}', '{"b":2}']));
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
    const result = JSON.parse(mergeJson(['{"a":1}', '{"a":2}']));
    expect(result.a).toBe(2);
  });

  it('first_wins keeps first value', () => {
    const result = JSON.parse(
      mergeJson(['{"a":1}', '{"a":2}'], { conflicts: 'first_wins' }),
    );
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
    );
    expect(result).toEqual({ db: { host: 'a', port: 5433 } });
  });

  it('objects:replace overwrites the whole object', () => {
    const result = JSON.parse(
      mergeJson(['{"db":{"host":"a","port":5432}}', '{"db":{"port":5433}}'], {
        objects: 'replace',
      }),
    );
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
    const result = JSON.parse(mergeJson(['{"x":[1,2]}', '{"x":[3,4]}']));
    expect(result.x).toEqual([3, 4]);
  });

  it('concat appends arrays', () => {
    const result = JSON.parse(
      mergeJson(['{"x":[1,2]}', '{"x":[3,4]}'], { arrays: 'concat' }),
    );
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

describe('mergeJson — three sources', () => {
  it('applies last_wins across all sources', () => {
    const result = JSON.parse(mergeJson(['{"a":1}', '{"a":2}', '{"a":3}']));
    expect(result.a).toBe(3);
  });

  it('first_wins across all sources', () => {
    const result = JSON.parse(
      mergeJson(['{"a":1}', '{"a":2}', '{"a":3}'], {
        conflicts: 'first_wins',
      }),
    );
    expect(result.a).toBe(1);
  });
});
