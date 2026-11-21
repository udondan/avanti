// ── Merge helpers for key/value nodes ─────────────────────────────────────────
import { findLastIndex } from '../find-last';
import type { IniKeyValue, IniScalar, IniSectionItem } from './types';

export type ResolvedOptions = {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat' | 'dedupe';
  objects: 'replace' | 'merge';
};

function scalarsEqual(a: IniScalar, b: IniScalar): boolean {
  return a === b;
}

function arraysEqual(a: IniScalar[], b: IniScalar[]): boolean {
  return a.length === b.length && a.every((v, i) => scalarsEqual(v, b[i]));
}

export function valuesEqual(
  a: IniScalar | IniScalar[],
  b: IniScalar | IniScalar[],
): boolean {
  // Callers only compare values of the same shape (scalar↔array changes are
  // detected beforehand), but stay defensive about mixed shapes.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && arraysEqual(a, b);
  }
  return scalarsEqual(a, b);
}

function dedupeArrayValues(
  base: IniScalar[],
  overlay: IniScalar[],
): IniScalar[] {
  const result = [...base];
  for (const item of overlay) {
    if (!result.some((e) => scalarsEqual(e, item))) result.push(item);
  }
  return result;
}

/**
 * Applies the conflict strategy: throws under abort, and returns whether the
 * overlay wins (last_wins) or the base is kept (first_wins).
 */
export function overlayWins(opts: ResolvedOptions, path: string): boolean {
  if (opts.conflicts === 'abort') throw new Error(`INI conflict at ${path}`);
  return opts.conflicts !== 'first_wins';
}

// Adopt the overlay sep only when the shape changes (bare ↔ key=value); keep
// the base sep when both sides are key=value.
function adoptSep(baseKv: IniKeyValue, overlay: IniKeyValue): void {
  if ((baseKv.sep === '') !== (overlay.sep === '')) baseKv.sep = overlay.sep;
}

function mergeArrays(
  base: IniScalar[],
  overlay: IniScalar[],
  arrays: ResolvedOptions['arrays'],
): IniScalar[] | null {
  if (arrays === 'concat') return [...base, ...overlay];
  if (arrays === 'dedupe') return dedupeArrayValues(base, overlay);
  // replace (default) falls through to conflict handling
  return null;
}

// New key — insert after the last existing KV; if none exist, append at end
// so that leading comment/blank nodes are not displaced.
function insertNewKv(items: IniSectionItem[], overlay: IniKeyValue): void {
  const lastKv = findLastIndex(items, (it) => it.kind === 'kv');
  items.splice(lastKv === -1 ? items.length : lastKv + 1, 0, { ...overlay });
}

export function mergeKvIntoItems(
  items: IniSectionItem[],
  overlay: IniKeyValue,
  opts: ResolvedOptions,
  path: string, // never empty: it always ends with the (non-empty) key
): void {
  // Match by key only (ignoring isArray) so that a scalar↔array type change on
  // the same key is handled by the conflict strategy rather than silently
  // producing duplicate entries (one scalar + one array) in the output.
  const idx = findLastIndex(
    items,
    (it) => it.kind === 'kv' && it.key === overlay.key,
  );
  if (idx === -1) {
    insertNewKv(items, overlay);
    return;
  }
  const baseKv = items[idx] as IniKeyValue;

  // Scalar↔array type change: treat as a conflict regardless of array strategy.
  if (baseKv.isArray !== overlay.isArray) {
    if (overlayWins(opts, path)) {
      // last_wins: replace value and type in-place.
      baseKv.value = overlay.value;
      baseKv.isArray = overlay.isArray;
      adoptSep(baseKv, overlay);
    }
    return;
  }

  if (valuesEqual(baseKv.value, overlay.value)) return;

  const merged =
    Array.isArray(baseKv.value) && Array.isArray(overlay.value)
      ? mergeArrays(baseKv.value, overlay.value, opts.arrays)
      : null;
  if (merged) {
    baseKv.value = merged;
  } else if (overlayWins(opts, path)) {
    // last_wins: update value in-place.
    baseKv.value = overlay.value;
    adoptSep(baseKv, overlay);
  }
}
