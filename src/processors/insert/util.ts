/** Shared helpers for removing a previous insert contribution. */
import { findLastIndex } from '../find-last';
import { compareCodeUnits } from '../sort';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function sortedStringify(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map(sortedStringify).join(',') + ']';
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(compareCodeUnits);
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + sortedStringify(v[k]))
        .join(',') +
      '}'
    );
  }
  // Tag Date distinctly so it never compares equal to an ISO string.
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  return JSON.stringify(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return sortedStringify(a) === sortedStringify(b);
}

// ── Array contribution removal (searching from end) ──────────────────────────

export function removeArrayContribution(
  existing: unknown[],
  oldItems: unknown[],
  toJs: (item: unknown) => unknown = (x) => x,
): unknown[] {
  // Returns the old items that were not found, in their original order.
  const notFound: unknown[] = [];
  for (let i = oldItems.length - 1; i >= 0; i--) {
    const target = oldItems[i];
    const j = findLastIndex(existing, (item) => deepEqual(toJs(item), target));
    if (j === -1) notFound.unshift(target);
    else existing.splice(j, 1);
  }
  return notFound;
}

/** The new contribution's value for `key`, or undefined when it has none. */
export function newValueOf(
  newContrib: Record<string, unknown> | null,
  key: string,
): unknown {
  return newContrib != null && Object.hasOwn(newContrib, key)
    ? newContrib[key]
    : undefined;
}

// Order-preservation only works under last_wins; with first_wins the stale key
// would persist, and with abort the merge would throw on the un-removed key.
export function isLastWins(opts: Record<string, unknown>): boolean {
  const rawConflicts = opts['conflicts'];
  return rawConflicts !== 'abort' && rawConflicts !== 'first_wins';
}

/**
 * The new contribution as an object, used to keep keys it still has in place.
 * Null unless conflicts resolve to last_wins and the text parses to an object.
 */
export function parseNewContrib(
  processedText: string,
  opts: Record<string, unknown>,
  parse: (text: string) => unknown,
): Record<string, unknown> | null {
  let newContrib: Record<string, unknown> | null = null;
  if (isLastWins(opts)) {
    try {
      const p = parse(processedText);
      if (isPlainObject(p)) newContrib = p;
    } catch {
      // unparseable processedText → null (old behaviour)
    }
  }
  return newContrib;
}
