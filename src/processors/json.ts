import { JsonMergeOptions } from '../types';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ResolvedOptions {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat';
  objects: 'replace' | 'merge';
}

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeValues(
  path: string,
  a: JsonValue,
  b: JsonValue,
  opts: ResolvedOptions,
): JsonValue {
  // Identical values — no conflict
  if (JSON.stringify(a) === JSON.stringify(b)) return a;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (opts.arrays === 'concat') return [...a, ...b];
    // arrays: replace — fall through to conflict handling
  } else if (isPlainObject(a) && isPlainObject(b)) {
    if (opts.objects === 'merge') return deepMerge(a, b, opts, path);
    // objects: replace — fall through to conflict handling
  }

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`JSON conflict at ${loc}`);
  }
  if (opts.conflicts === 'first_wins') return a;
  return b;
}

function deepMerge(
  a: Record<string, JsonValue>,
  b: Record<string, JsonValue>,
  opts: ResolvedOptions,
  basePath: string,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { ...a };
  for (const [key, bVal] of Object.entries(b)) {
    const childPath = basePath ? `${basePath}.${key}` : key;
    if (key in result) {
      result[key] = mergeValues(childPath, result[key], bVal, opts);
    } else {
      result[key] = bVal;
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

  if (parts.length === 0) return 'null';

  const parsed = parts.map((p, i) => {
    try {
      return JSON.parse(p) as JsonValue;
    } catch (e) {
      throw new Error(
        `[source ${i}]: invalid JSON: ${(e as SyntaxError).message}`,
        { cause: e },
      );
    }
  });

  let result = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    result = mergeValues('', result, parsed[i], resolved);
  }

  return JSON.stringify(result, null, 2);
}

export function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content) as JsonValue, null, 2);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as SyntaxError).message}`, {
      cause: e,
    });
  }
}
