export function applyFilter(
  files: Map<string, Buffer>,
  patterns: string[],
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const [key, value] of files) {
    if (matchesAny(key, patterns)) {
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

function matchesAny(key: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(key, p));
}

function matchesPattern(key: string, pattern: string): boolean {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = new RegExp(pattern.slice(1, -1));
    return re.test(key);
  }
  if (pattern.includes('{')) {
    return expandBraces(pattern).some((expanded) => expanded === key);
  }
  return pattern === key;
}

export function expandBraces(pattern: string): string[] {
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
  const results: string[] = [];
  for (const alt of alternatives) {
    for (const expanded of expandBraces(prefix + alt + suffix)) {
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
