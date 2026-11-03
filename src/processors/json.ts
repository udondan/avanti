import { parse, stringify, assign } from 'comment-json';
import { JsonMergeOptions } from '../types';

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
    if (opts.arrays === 'dedupe') return dedupeArrays(a, b);
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

function resolveIndent(opts: JsonMergeOptions): string | number {
  return opts.indent === 'tab' ? '\t' : (opts.indent ?? 2);
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
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

function addTrailingCommas(json: string): string {
  const lines = json.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let nextNonBlank = i + 1;
    while (nextNonBlank < lines.length) {
      const t = lines[nextNonBlank].trim();
      if (
        t === '' ||
        t.startsWith('//') ||
        t.startsWith('/*') ||
        t.startsWith('*')
      ) {
        nextNonBlank++;
      } else {
        break;
      }
    }

    if (nextNonBlank < lines.length) {
      const nextTrimmed = lines[nextNonBlank].trim();
      if (nextTrimmed.startsWith('}') || nextTrimmed.startsWith(']')) {
        const trimmed = line.trim();
        if (
          trimmed &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('*')
        ) {
          // Find the position of a line comment, if any
          const commentIdx = findLineCommentIndex(line);
          const effectiveEnd =
            commentIdx >= 0
              ? line.substring(0, commentIdx).trimEnd()
              : line.trimEnd();
          const lastChar = effectiveEnd.slice(-1);

          if (
            lastChar &&
            lastChar !== ',' &&
            lastChar !== '{' &&
            lastChar !== '['
          ) {
            if (commentIdx >= 0) {
              result.push(
                effectiveEnd +
                  ',' +
                  ' ' +
                  line.substring(commentIdx).trimStart(),
              );
            } else {
              result.push(effectiveEnd + ',');
            }
            continue;
          }
        }
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

function findLineCommentIndex(line: string): number {
  let inString = false;
  let escape = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === '/' && line[i + 1] === '/') {
      return i;
    }
  }
  return -1;
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

  const toFormat = opts.sortKeys ? sortJsonKeys(result) : result;

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

export function formatJson(
  content: string,
  opts: JsonMergeOptions = {},
): string {
  try {
    const parsed = parse(content);
    const toFormat = opts.sortKeys ? sortJsonKeys(parsed) : parsed;

    if (opts.minify) {
      return JSON.stringify(toFormat) + '\n';
    }
    if (opts.stripComments) {
      const clean = JSON.parse(JSON.stringify(toFormat)) as unknown;
      return String(stringify(clean, null, resolveIndent(opts))) + '\n';
    }

    let output = String(stringify(toFormat, null, resolveIndent(opts)));
    if (opts.trailingCommas) {
      output = addTrailingCommas(output);
    }
    return output + '\n';
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as SyntaxError).message}`, {
      cause: e,
    });
  }
}
