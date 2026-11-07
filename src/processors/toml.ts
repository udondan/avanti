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
  arrays: 'replace' | 'concat' | 'dedupe';
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

function objectsEqual(
  a: Record<string, TomlValue>,
  b: Record<string, TomlValue>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k]))
  );
}

function containersEqual(a: TomlValue, b: TomlValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  return isPlainObject(a) && isPlainObject(b) && objectsEqual(a, b);
}

function valuesEqual(a: TomlValue, b: TomlValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return isNaN(a) && isNaN(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return containersEqual(a, b);
}

function dedupeArrays(a: TomlValue[], b: TomlValue[]): TomlValue[] {
  const result = [...a];
  for (const item of b) {
    if (!result.some((e) => valuesEqual(e, item))) {
      result.push(item);
    }
  }
  return result;
}

function mergeArrays(
  a: TomlValue[],
  b: TomlValue[],
  arrays: ResolvedOptions['arrays'],
): TomlValue | undefined {
  if (arrays === 'concat') return [...a, ...b];
  if (arrays === 'dedupe') return dedupeArrays(a, b);
  return undefined;
}

// Merges two arrays or two tables per the options; undefined when the values
// conflict instead.
function mergeContainers(
  path: string,
  a: TomlValue,
  b: TomlValue,
  opts: ResolvedOptions,
): TomlValue | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    return mergeArrays(a, b, opts.arrays);
  }
  if (isPlainObject(a) && isPlainObject(b) && opts.objects === 'merge') {
    return deepMerge(a, b, opts, path);
  }
  return undefined;
}

function mergeValues(
  path: string,
  a: TomlValue,
  b: TomlValue,
  opts: ResolvedOptions,
): TomlValue {
  if (valuesEqual(a, b)) return a;

  const merged = mergeContainers(path, a, b, opts);
  if (merged !== undefined) return merged;

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`TOML conflict at ${loc}`);
  }
  return opts.conflicts === 'first_wins' ? a : b;
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

  // smol-toml's stringify always ends its output with a newline.
  return stringify(result as Parameters<typeof stringify>[0]);
}

export function formatToml(content: string): string {
  try {
    return stringify(parse(content));
  } catch (e) {
    throw new Error(`invalid TOML: ${(e as Error).message}`, { cause: e });
  }
}
