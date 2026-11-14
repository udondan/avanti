import { parse, assign } from 'comment-json';
import { JsonMergeOptions } from '../types';
import { renderJson } from './json/render';

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ResolvedOptions {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat' | 'dedupe';
  objects: 'replace' | 'merge';
}

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function dedupeArrays(a: JsonValue[], b: JsonValue[]): JsonValue[] {
  const result = [...a];
  for (const item of b) {
    const key = JSON.stringify(item);
    if (!result.some((e) => JSON.stringify(e) === key)) {
      result.push(item);
    }
  }
  return result;
}

function mergeArrays(
  a: JsonValue[],
  b: JsonValue[],
  arrays: ResolvedOptions['arrays'],
): JsonValue | undefined {
  if (arrays === 'concat') return [...a, ...b];
  if (arrays === 'dedupe') return dedupeArrays(a, b);
  // arrays: replace — fall through to conflict handling
  return undefined;
}

// Merges two arrays or two objects per the options; undefined when the
// values conflict instead.
function mergeContainers(
  path: string,
  a: JsonValue,
  b: JsonValue,
  opts: ResolvedOptions,
): JsonValue | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    return mergeArrays(a, b, opts.arrays);
  }
  if (isPlainObject(a) && isPlainObject(b) && opts.objects === 'merge') {
    return deepMerge(a, b, opts, path);
  }
  // objects: replace — fall through to conflict handling
  return undefined;
}

function mergeValues(
  path: string,
  a: JsonValue,
  b: JsonValue,
  opts: ResolvedOptions,
): JsonValue {
  // Identical values — no conflict
  if (JSON.stringify(a) === JSON.stringify(b)) return a;

  const merged = mergeContainers(path, a, b, opts);
  if (merged !== undefined) return merged;

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`JSON conflict at ${loc}`);
  }
  return opts.conflicts === 'first_wins' ? a : b;
}

function deepMerge(
  a: Record<string, JsonValue>,
  b: Record<string, JsonValue>,
  opts: ResolvedOptions,
  basePath: string,
): Record<string, JsonValue> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = assign({} as any, a) as Record<string, JsonValue>;
  for (const [key, bVal] of Object.entries(b)) {
    const childPath = basePath ? `${basePath}.${key}` : key;
    if (key in result) {
      result[key] = mergeValues(childPath, result[key], bVal, opts);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assign(result as any, b as any, [key]);
    }
  }
  return result;
}

export function mergeJson(
  parts: string[],
  opts: JsonMergeOptions = {},
): string {
  const resolved: ResolvedOptions = {
    conflicts: opts.conflicts ?? 'last_wins',
    arrays: opts.arrays ?? 'replace',
    objects: opts.objects ?? 'merge',
  };

  if (parts.length === 0) return 'null\n';

  const parsed = parts.map((p, i) => {
    try {
      return parse(p);
    } catch (e) {
      throw new Error(
        `[source ${i}]: invalid JSON: ${(e as SyntaxError).message}`,
        { cause: e },
      );
    }
  });

  let result: JsonValue = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    result = mergeValues('', result, parsed[i], resolved);
  }

  return renderJson(result, opts);
}

export function formatJson(
  content: string,
  opts: JsonMergeOptions = {},
): string {
  try {
    return renderJson(parse(content), opts);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as SyntaxError).message}`, {
      cause: e,
    });
  }
}
