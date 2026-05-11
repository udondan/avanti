import { parse, stringify } from 'smol-toml';
import { TomlMergeOptions } from '../types';

type TomlValue =
  | null
  | boolean
  | number
  | string
  | Date
  | TomlValue[]
  | { [key: string]: TomlValue };

interface ResolvedOptions {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat';
  objects: 'replace' | 'merge';
}

function isPlainObject(v: unknown): v is Record<string, TomlValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function valuesEqual(a: TomlValue, b: TomlValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeValues(
  path: string,
  a: TomlValue,
  b: TomlValue,
  opts: ResolvedOptions,
): TomlValue {
  if (valuesEqual(a, b)) return a;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (opts.arrays === 'concat') return [...a, ...b];
  } else if (isPlainObject(a) && isPlainObject(b)) {
    if (opts.objects === 'merge') return deepMerge(a, b, opts, path);
  }

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`TOML conflict at ${loc}`);
  }
  if (opts.conflicts === 'first_wins') return a;
  return b;
}

function deepMerge(
  a: Record<string, TomlValue>,
  b: Record<string, TomlValue>,
  opts: ResolvedOptions,
  basePath: string,
): Record<string, TomlValue> {
  const result: Record<string, TomlValue> = { ...a };
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

export function mergeToml(
  parts: string[],
  opts: TomlMergeOptions = {},
): string {
  const resolved: ResolvedOptions = {
    conflicts: opts.conflicts ?? 'last_wins',
    arrays: opts.arrays ?? 'replace',
    objects: opts.objects ?? 'merge',
  };

  if (parts.length === 0) return '';

  const parsed = parts.map((p, i) => {
    try {
      return parse(p) as Record<string, TomlValue>;
    } catch (e) {
      throw new Error(`[source ${i}]: invalid TOML: ${(e as Error).message}`, {
        cause: e,
      });
    }
  });

  let result: Record<string, TomlValue> = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    result = deepMerge(result, parsed[i], resolved, '');
  }

  return stringify(result as Parameters<typeof stringify>[0]);
}

export function formatToml(content: string): string {
  try {
    return stringify(parse(content) as Parameters<typeof stringify>[0]);
  } catch (e) {
    throw new Error(`invalid TOML: ${(e as Error).message}`, { cause: e });
  }
}
