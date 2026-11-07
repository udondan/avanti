/**
 * Removes a previous contribution from a parsed mapping, keyed by format
 * through a small adapter (plain objects for JSON/TOML, AST maps for YAML).
 */
import {
  deepEqual,
  isPlainObject,
  newValueOf,
  removeArrayContribution,
} from './util';

export interface MapAdapter<M> {
  /** The value stored under `key`, or undefined when `map` has no such key. */
  lookup: (map: M, key: string) => { value: unknown } | undefined;
  remove: (map: M, key: string) => void;
  isMap: (value: unknown) => value is M;
  isSeq: (value: unknown) => boolean;
  /** The items of a value `isSeq` accepted. */
  seqItems: (value: unknown) => unknown[];
  size: (map: M) => number;
  toJs: (value: unknown) => unknown;
}

export function deepRemove<M>(
  adapter: MapAdapter<M>,
  base: M,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null = null,
): void {
  for (const key of Object.keys(oldContrib)) {
    const entry = adapter.lookup(base, key);
    if (!entry) continue;
    const oldVal = oldContrib[key];
    const newVal = newValueOf(newContrib, key);
    if (removeNested(adapter, entry.value, oldVal, newVal)) {
      adapter.remove(base, key);
    }
  }
}

// Removes `oldVal` from `curVal`; returns true when the key itself must go.
function removeNested<M>(
  adapter: MapAdapter<M>,
  curVal: unknown,
  oldVal: unknown,
  newVal: unknown,
): boolean {
  if (isPlainObject(oldVal) && adapter.isMap(curVal)) {
    const nestedNew = isPlainObject(newVal) ? newVal : null;
    deepRemove(adapter, curVal, oldVal, nestedNew);
    return adapter.size(curVal) === 0 && newVal === undefined;
  }
  if (Array.isArray(oldVal) && adapter.isSeq(curVal)) {
    const seq = adapter.seqItems(curVal);
    removeArrayContribution(seq, oldVal, adapter.toJs);
    return seq.length === 0 && newVal === undefined;
  }
  if (newVal !== undefined) return false;
  return deepEqual(adapter.toJs(curVal), oldVal);
}

/** Adapter for plain parsed objects (JSON via comment-json, TOML). */
export const objectAdapter: MapAdapter<Record<string, unknown>> = {
  lookup: (map, key) =>
    Object.hasOwn(map, key) ? { value: map[key] } : undefined,
  remove: (map, key) => {
    delete map[key];
  },
  isMap: isPlainObject,
  isSeq: Array.isArray,
  seqItems: (value) => value as unknown[],
  size: (map) => Object.keys(map).length,
  toJs: (value) => value,
};
