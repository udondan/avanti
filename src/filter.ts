type CompiledPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'brace'; expanded: Set<string> };

function compilePattern(pattern: string): CompiledPattern {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return { kind: 'regex', re: new RegExp(pattern.slice(1, -1)) };
  }
  if (pattern.includes('{')) {
    return { kind: 'brace', expanded: new Set(expandBraces(pattern)) };
  }
  return { kind: 'exact', value: pattern };
}

function matchesCompiled(key: string, compiled: CompiledPattern): boolean {
  if (compiled.kind === 'regex') return compiled.re.test(key);
  if (compiled.kind === 'brace') return compiled.expanded.has(key);
  return compiled.value === key;
}

export function applyFilter(
  files: Map<string, Buffer>,
  patterns: string[],
): Map<string, Buffer> {
  const compiled = patterns.map(compilePattern);
  const result = new Map<string, Buffer>();
  for (const [key, value] of files) {
    const normalizedKey = key.replace(/\\/g, '/');
    if (compiled.some((p) => matchesCompiled(normalizedKey, p))) {
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
  const results = _expandBraces(pattern);
  if (results.length > limit)
    throw new Error(`brace expansion exceeds ${limit} entries`);
  return results;
}

function _expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];

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

  if (close === -1) return [pattern];

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const inner = pattern.slice(open + 1, close);

  const alternatives = splitTopLevel(inner);
  // Only expand when there is at least one comma — {foo} without a comma stays
  // literal, matching bash/paths.ts behaviour and avoiding accidental expansion
  // of {placeholder} tokens that users may intend as literal.
  if (alternatives.length < 2) return [pattern];

  const results: string[] = [];
  for (const alt of alternatives) {
    for (const expanded of _expandBraces(prefix + alt + suffix)) {
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
