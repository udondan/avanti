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
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function valuesEqual(a: TomlValue, b: TomlValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return isNaN(a) && isNaN(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k]))
    );
  }
  return false;
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
    const newVal = Object.hasOwn(result, key)
      ? mergeValues(childPath, result[key], bVal, opts)
      : bVal;
    // Use defineProperty to avoid prototype mutation for keys like __proto__
    Object.defineProperty(result, key, {
      value: newVal,
      writable: true,
      enumerable: true,
      configurable: true,
    });
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
