/** Serialises a merged or parsed JSON value according to the output options. */
import { stringify } from 'comment-json';
import type { JsonMergeOptions } from '../../types';
import { compareCodeUnits } from '../sort';
import { addTrailingCommas } from './trailing-commas';

function resolveIndent(opts: JsonMergeOptions): string | number {
  return opts.indent === 'tab' ? '\t' : (opts.indent ?? 2);
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort(compareCodeUnits)
      .reduce<Record<string, unknown>>(
        (acc, k) => {
          acc[k] = sortJsonKeys(obj[k]);
          return acc;
        },
        Object.create(null) as Record<string, unknown>,
      );
  }
  return value;
}

export function renderJson(value: unknown, opts: JsonMergeOptions): string {
  const toFormat = opts.sortKeys ? sortJsonKeys(value) : value;

  if (opts.minify) {
    return JSON.stringify(toFormat) + '\n';
  }
  if (opts.stripComments) {
    // JSON.stringify strips Symbol-based comment metadata; re-parse to get a plain object,
    // then use comment-json stringify which has no 10-space indent cap.
    const clean = JSON.parse(JSON.stringify(toFormat)) as unknown;
    return String(stringify(clean, null, resolveIndent(opts))) + '\n';
  }

  let output = String(stringify(toFormat, null, resolveIndent(opts)));
  if (opts.trailingCommas) {
    output = addTrailingCommas(output);
  }
  return output + '\n';
}
