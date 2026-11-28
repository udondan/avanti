import { expandBraces } from './filter/braces';

export { expandBraces };

type CompiledPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'prefix'; value: string }
  | { kind: 'glob'; re: RegExp };

function globToRegex(pattern: string): RegExp {
  let re = '^';
  let lastCh = '';
  for (const ch of pattern) {
    if (ch === '*') {
      if (lastCh !== '*') re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
    lastCh = ch;
  }
  re += '$';
  return new RegExp(re);
}

function compilePattern(pattern: string): CompiledPattern {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const source = pattern.slice(1, -1);
    try {
      return { kind: 'regex', re: new RegExp(source) };
    } catch (err) {
      throw new Error(`pattern ${JSON.stringify(pattern)}: invalid regex`, {
        cause: err,
      });
    }
  }
  if (pattern.endsWith('/')) {
    if (pattern.includes('{')) {
      let expanded: string[];
      try {
        expanded = expandBraces(pattern, 2);
      } catch {
        expanded = ['', ''];
      }
      if (expanded.length > 1) {
        throw new Error(
          `pattern ${JSON.stringify(pattern)}: brace expansion is not supported in directory-prefix patterns (ending with "/"); use separate patterns instead, e.g. "core/" and "utils/" instead of "{core,utils}/"`,
        );
      }
    }
    return { kind: 'prefix', value: pattern };
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    return { kind: 'glob', re: globToRegex(pattern) };
  }
  return { kind: 'exact', value: pattern };
}

function matchesCompiled(key: string, compiled: CompiledPattern): boolean {
  if (compiled.kind === 'regex') return compiled.re.test(key);
  if (compiled.kind === 'glob') return compiled.re.test(key);
  if (compiled.kind === 'prefix') return key.startsWith(compiled.value);
  return compiled.value === key;
}

export function compilePatterns(patterns: string[]): CompiledPattern[] {
  const flat: string[] = [];
  for (const p of patterns) {
    // Expand braces into individual alternatives first so that combined
    // patterns like "tool-{amd64,arm64}-*.tar.gz" have their glob wildcard
    // compiled correctly (brace kind performs exact string lookup, not glob).
    // Directory-prefix patterns (ending with "/") are left unexpanded to
    // preserve the existing error for brace+prefix combinations.
    if (p.includes('{') && !p.endsWith('/')) {
      flat.push(...expandBraces(p));
    } else {
      flat.push(p);
    }
  }
  return flat.map(compilePattern);
}

export function matchesAnyPattern(
  key: string,
  compiled: CompiledPattern[],
): boolean {
  const normalizedKey = key.replace(/\\/g, '/');
  return compiled.some((p) => matchesCompiled(normalizedKey, p));
}

export function applyFilter(
  files: Map<string, Buffer>,
  patterns: string[],
): Map<string, Buffer> {
  const compiled = compilePatterns(patterns);
  const result = new Map<string, Buffer>();
  for (const [key, value] of files) {
    if (matchesAnyPattern(key, compiled)) {
      result.set(key, value);
    }
  }
  if (result.size === 0) {
    throw new Error(
      `filter matched no files (${patterns.length} pattern${patterns.length === 1 ? '' : 's'}: ${patterns.map((p) => JSON.stringify(p)).join(', ')})`,
    );
  }
  return result;
}
