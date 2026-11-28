interface BraceBudget {
  remaining: number;
  limit: number;
}

export function expandBraces(pattern: string, limit = 100): string[] {
  const budget = { remaining: limit, limit };
  return _expandBraces(pattern, budget);
}

/** Emits `pattern` unexpanded, charging one entry against the budget. */
function literal(pattern: string, budget: BraceBudget): string[] {
  if (--budget.remaining < 0)
    throw new Error(`brace expansion exceeds ${budget.limit} entries`);
  return [pattern];
}

/** Index of the `}` matching the `{` at `open`, or -1 when unbalanced. */
function findMatchingClose(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function _expandBraces(pattern: string, budget: BraceBudget): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return literal(pattern, budget);

  const close = findMatchingClose(pattern, open);
  if (close === -1) return literal(pattern, budget);

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const inner = pattern.slice(open + 1, close);

  const alternatives = splitTopLevel(inner);
  // Only expand when there is at least one comma — {foo} without a comma stays
  // literal, matching src/paths.ts behaviour and avoiding accidental expansion
  // of {placeholder} tokens that users may intend as literal.
  if (alternatives.length < 2) return literal(pattern, budget);

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
