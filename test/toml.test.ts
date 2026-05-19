import { describe, it, expect } from 'vitest';
import { parse } from 'smol-toml';
import { mergeToml, formatToml } from '../src/processors/toml';

describe('formatToml', () => {
  it('round-trips valid TOML', () => {
    const input = 'a = 1\nb = "hello"\n';
    const result = formatToml(input);
    expect(parse(result)).toEqual({ a: 1, b: 'hello' });
  });

  it('is idempotent', () => {
    const input = 'a = 1\n';
    expect(formatToml(formatToml(input))).toBe(formatToml(input));
  });

  it('throws on invalid TOML', () => {
    expect(() => formatToml('key =')).toThrow('invalid TOML');
  });
});

describe('mergeToml — basic', () => {
  it('returns single source formatted', () => {
    const result = parse(mergeToml(['a = 1\n'])) as { a: number };
    expect(result.a).toBe(1);
  });

  it('merges disjoint keys', () => {
    const result = parse(mergeToml(['a = 1\n', 'b = 2\n'])) as unknown;
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('throws on invalid TOML in source', () => {
    expect(() => mergeToml(['a = 1\n', 'key ='])).toThrow(
      '[source 1]: invalid TOML',
    );
  });
});

describe('mergeToml — conflicts (scalars)', () => {
  it('last_wins by default', () => {
    const result = parse(mergeToml(['a = 1\n', 'a = 2\n'])) as { a: number };
    expect(result.a).toBe(2);
  });

  it('first_wins keeps first value', () => {
    const result = parse(
      mergeToml(['a = 1\n', 'a = 2\n'], { conflicts: 'first_wins' }),
    ) as { a: number };
    expect(result.a).toBe(1);
  });

  it('abort throws on conflicting scalar', () => {
    expect(() =>
      mergeToml(['a = 1\n', 'a = 2\n'], { conflicts: 'abort' }),
    ).toThrow('TOML conflict at a');
  });

  it('abort does not throw when values are identical', () => {
    expect(() =>
      mergeToml(['a = 1\n', 'a = 1\n'], { conflicts: 'abort' }),
    ).not.toThrow();
  });
});

describe('mergeToml — objects (tables)', () => {
  it('deep-merges nested tables by default', () => {
    const a = '[db]\nhost = "a"\nport = 5432\n';
    const b = '[db]\nport = 5433\n';
    const result = parse(mergeToml([a, b])) as unknown;
    expect(result).toEqual({ db: { host: 'a', port: 5433 } });
  });

  it('objects:replace overwrites the whole table', () => {
    const a = '[db]\nhost = "a"\nport = 5432\n';
    const b = '[db]\nport = 5433\n';
    const result = parse(mergeToml([a, b], { objects: 'replace' })) as unknown;
    expect(result).toEqual({ db: { port: 5433 } });
  });

  it('reports nested key path in abort error', () => {
    const a = '[db]\nhost = "a"\n';
    const b = '[db]\nhost = "b"\n';
    expect(() => mergeToml([a, b], { conflicts: 'abort' })).toThrow(
      'TOML conflict at db.host',
    );
  });
});

describe('mergeToml — arrays', () => {
  it('replace overwrites array by default', () => {
    const result = parse(mergeToml(['x = [1, 2]\n', 'x = [3, 4]\n'])) as {
      x: number[];
    };
    expect(result.x).toEqual([3, 4]);
  });

  it('concat appends arrays', () => {
    const result = parse(
      mergeToml(['x = [1, 2]\n', 'x = [3, 4]\n'], { arrays: 'concat' }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4]);
  });

  it('abort throws on conflicting arrays when arrays:replace', () => {
    expect(() =>
      mergeToml(['x = [1]\n', 'x = [2]\n'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).toThrow('TOML conflict at x');
  });

  it('abort does not throw on identical arrays', () => {
    expect(() =>
      mergeToml(['x = [1, 2]\n', 'x = [1, 2]\n'], {
        conflicts: 'abort',
        arrays: 'replace',
      }),
    ).not.toThrow();
  });
});

describe('mergeToml — arrays: dedupe', () => {
  it('appends only items not already present (primitives)', () => {
    const result = parse(
      mergeToml(['x = [1, 2, 3]\n', 'x = [2, 3, 4, 5]\n'], {
        arrays: 'dedupe',
      }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4, 5]);
  });

  it('appends all items when there are no duplicates', () => {
    const result = parse(
      mergeToml(['x = [1, 2]\n', 'x = [3, 4]\n'], { arrays: 'dedupe' }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4]);
  });

  it('keeps base array unchanged when all overlay items already present', () => {
    const result = parse(
      mergeToml(['x = [1, 2, 3]\n', 'x = [1, 2]\n'], { arrays: 'dedupe' }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3]);
  });

  it('accumulates correctly across three sources', () => {
    const result = parse(
      mergeToml(['x = [1, 2]\n', 'x = [2, 3]\n', 'x = [3, 4]\n'], {
        arrays: 'dedupe',
      }),
    ) as { x: number[] };
    expect(result.x).toEqual([1, 2, 3, 4]);
  });

  it('preserves order: base items first, new items in encounter order', () => {
    const result = parse(
      mergeToml(['x = [3, 1, 2]\n', 'x = [2, 4, 1, 5]\n'], {
        arrays: 'dedupe',
      }),
    ) as { x: number[] };
    expect(result.x).toEqual([3, 1, 2, 4, 5]);
  });

  it('deduplicates Date values using getTime() comparison', () => {
    const a = 'ts = [1987-07-05T17:45:00Z]\n';
    const b = 'ts = [1987-07-05T17:45:00Z, 2000-01-01T00:00:00Z]\n';
    const result = parse(
      mergeToml([a, b], { arrays: 'dedupe' }),
    ) as unknown as {
      ts: Date[];
    };
    expect(result.ts).toHaveLength(2);
    expect(result.ts[0].getFullYear()).toBe(1987);
    expect(result.ts[1].getFullYear()).toBe(2000);
  });
});

describe('mergeToml — three sources', () => {
  it('applies last_wins across all sources', () => {
    const result = parse(mergeToml(['a = 1\n', 'a = 2\n', 'a = 3\n'])) as {
      a: number;
    };
    expect(result.a).toBe(3);
  });

  it('first_wins across all sources', () => {
    const result = parse(
      mergeToml(['a = 1\n', 'a = 2\n', 'a = 3\n'], {
        conflicts: 'first_wins',
      }),
    ) as { a: number };
    expect(result.a).toBe(1);
  });
});

describe('mergeToml — datetime values', () => {
  it('treats identical datetimes as equal (no conflict)', () => {
    const a = 'ts = 1987-07-05T17:45:00Z\n';
    const b = 'ts = 1987-07-05T17:45:00Z\n';
    expect(() => mergeToml([a, b], { conflicts: 'abort' })).not.toThrow();
  });

  it('last_wins on different datetimes', () => {
    const a = 'ts = 1987-07-05T17:45:00Z\n';
    const b = 'ts = 2000-01-01T00:00:00Z\n';
    const result = parse(mergeToml([a, b])) as unknown as { ts: Date };
    expect(result.ts.getFullYear()).toBe(2000);
  });

  it('abort throws on different datetimes', () => {
    const a = 'ts = 1987-07-05T17:45:00Z\n';
    const b = 'ts = 2000-01-01T00:00:00Z\n';
    expect(() => mergeToml([a, b], { conflicts: 'abort' })).toThrow(
      'TOML conflict at ts',
    );
  });

  it('does not deep-merge Date values as objects', () => {
    const a = 'ts = 1987-07-05T17:45:00Z\n';
    const b = 'ts = 2000-01-01T00:00:00Z\n';
    const result = parse(
      mergeToml([a, b], { objects: 'merge' }),
    ) as unknown as {
      ts: Date;
    };
    // last_wins: b's date, not a partial merge of Date fields
    expect(result.ts.getFullYear()).toBe(2000);
  });
});

describe('trailing newline', () => {
  it('mergeToml output always ends with newline', () => {
    expect(mergeToml(['a = 1\n', 'b = 2\n'])).toMatch(/\n$/);
  });

  it('formatToml output always ends with newline', () => {
    expect(formatToml('a = 1')).toMatch(/\n$/);
  });
});
