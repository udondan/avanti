type CompiledPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'brace'; expanded: Set<string> }
  | { kind: 'prefix'; value: string }
  | { kind: 'glob'; re: RegExp };

function globToRegex(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
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
  if (pattern.includes('{')) {
    return { kind: 'brace', expanded: new Set(expandBraces(pattern)) };
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    return { kind: 'glob', re: globToRegex(pattern) };
  }
  return { kind: 'exact', value: pattern };
}

function matchesCompiled(key: string, compiled: CompiledPattern): boolean {
  if (compiled.kind === 'regex') return compiled.re.test(key);
  if (compiled.kind === 'glob') return compiled.re.test(key);
  if (compiled.kind === 'brace') return compiled.expanded.has(key);
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

export function expandBraces(pattern: string, limit = 100): string[] {
  const budget = { remaining: limit, limit };
  return _expandBraces(pattern, budget);
}

function _expandBraces(
  pattern: string,
  budget: { remaining: number; limit: number },
): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    if (--budget.remaining < 0)
      throw new Error(`brace expansion exceeds ${budget.limit} entries`);
    return [pattern];
  }

  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }

  if (close === -1) {
    if (--budget.remaining < 0)
      throw new Error(`brace expansion exceeds ${budget.limit} entries`);
    return [pattern];
  }

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const inner = pattern.slice(open + 1, close);

  const alternatives = splitTopLevel(inner);
  // Only expand when there is at least one comma — {foo} without a comma stays
  // literal, matching src/paths.ts behaviour and avoiding accidental expansion
  // of {placeholder} tokens that users may intend as literal.
  if (alternatives.length < 2) {
    if (--budget.remaining < 0)
      throw new Error(`brace expansion exceeds ${budget.limit} entries`);
    return [pattern];
  }

  const results: string[] = [];
  for (const alt of alternatives) {
    for (const expanded of _expandBraces(prefix + alt + suffix, budget)) {
      results.push(expanded);
    }
  }
  return results;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}
