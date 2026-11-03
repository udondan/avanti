import { describe, it, expect, vi } from 'vitest';

// js-yaml's default schema only produces plain values, but the config parser
// still guards against class instances in variable data (e.g. if the schema
// ever gains !!set or !!timestamp). Simulate such a loader result here.
const MARKER = '# avanti-test: non-plain variables';

class Custom {}
const NullCtor = Object.create(Object.create(null) as object) as object;

vi.mock('js-yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('js-yaml')>();
  return {
    ...actual,
    load: (content: string, ...rest: unknown[]) => {
      if (content.startsWith(MARKER)) {
        const which = content.slice(MARKER.length).trim();
        const value =
          which === 'set'
            ? { list: [1, new Set(['a'])] }
            : which === 'custom'
              ? { 'a.b': { c: new Custom() } }
              : { x: NullCtor };
        return { files: {}, variables: { v: value } };
      }
      return (actual.load as (c: string, ...r: unknown[]) => unknown)(
        content,
        ...rest,
      );
    },
  };
});

import { parseConfigContent } from '../src/config';

describe('parseConfigContent — non-plain variable values', () => {
  it('rejects class instances nested in lists', () => {
    expect(() => parseConfigContent(`${MARKER} set`)).toThrow(
      'variables.v.list[1]: expected a plain object but got Set — variable values must be strings, numbers, booleans, lists, or plain objects',
    );
  });

  it('quotes keys containing special characters in the error path', () => {
    expect(() => parseConfigContent(`${MARKER} custom`)).toThrow(
      'variables.v["a.b"].c: expected a plain object but got Custom',
    );
  });

  it('reports objects without a constructor as unknown', () => {
    expect(() => parseConfigContent(`${MARKER} nullctor`)).toThrow(
      'variables.v.x: expected a plain object but got unknown',
    );
  });

  it('still parses regular configs', () => {
    expect(parseConfigContent('files: {}\n').files).toEqual({});
  });
});
