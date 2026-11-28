/** INI helpers shared by the insert-mode removal and ownership modules. */
import type {
  IniBlank,
  IniComment,
  IniDocument,
  IniItem,
  IniKeyValue,
  IniSection,
} from '../ini';
import { deepEqual, isPlainObject, removeArrayContribution } from './util';

// Sentinel prefix for section keys in the JS representation so that a global
// key named "db" and a section named [db] never collide in the same object.
// Real INI keys cannot contain null bytes, making this unambiguous.
export const INI_SECTION_PREFIX = '\0s:';
// Sentinel prefix for array KV keys (key[] = val) so they never collide with
// a scalar KV of the same name (key = val) in the same JS object.
export const INI_ARRAY_PREFIX = '\0a:';

type IniSectionItems = (IniComment | IniBlank | IniKeyValue)[];

export function isKvNode(
  item: IniItem,
  key: string,
  isArray: boolean,
): item is IniKeyValue {
  return item.kind === 'kv' && item.key === key && item.isArray === isArray;
}

/** The last kv node with this key and shape, searching from the end. */
export function findLastKv(
  items: readonly IniItem[],
  key: string,
  isArray: boolean,
): IniKeyValue | undefined {
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j];
    if (isKvNode(it, key, isArray)) return it;
  }
  return undefined;
}

export function increment<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

// Remove contiguous comment/blank nodes immediately preceding `idx` in `items`.
// Stops when it reaches a kv or section boundary, preventing unrelated comments
// from being stripped. Call this after splicing a kv node to avoid leaving
// orphaned comments that would appear to annotate the next key.
export function splicePrecedingCommentBlanks(
  items: IniItem[],
  idx: number,
): void {
  let k = idx - 1;
  while (k >= 0 && (items[k].kind === 'comment' || items[k].kind === 'blank')) {
    items.splice(k, 1);
    k--;
  }
}

export function spliceIniNode(items: IniSectionItems, node: IniKeyValue): void {
  const idx = items.indexOf(node);
  items.splice(idx, 1);
  splicePrecedingCommentBlanks(items, idx);
}

// Finds all sections with this name, in file order. A file may repeat a
// section; mergeIni merges into the last one.
export function findIniSections(
  doc: IniDocument,
  name: string,
  subName: string | undefined,
): IniSection[] {
  return doc.items.filter(
    (it): it is IniSection =>
      it.kind === 'section' && it.name === name && it.subName === subName,
  );
}

export function iniSectionKey(
  name: string,
  subName: string | undefined,
): string {
  return subName !== undefined ? `${name} "${subName}"` : name;
}

export function iniScalarId(key: string, value: unknown): string {
  return JSON.stringify([key, value]);
}

function addKvToJs(target: Record<string, unknown>, kv: IniKeyValue): void {
  const jsKey = kv.isArray ? INI_ARRAY_PREFIX + kv.key : kv.key;
  target[jsKey] = kv.value;
}

function iniSectionToJs(section: IniSection): Record<string, unknown> {
  const obj: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const child of section.items) {
    if (child.kind === 'kv') addKvToJs(obj, child);
  }
  return obj;
}

export function iniDocToJs(doc: IniDocument): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const item of doc.items) {
    if (item.kind === 'kv') {
      addKvToJs(result, item);
    } else if (item.kind === 'section') {
      const sectionKey = iniSectionKey(item.name, item.subName);
      result[INI_SECTION_PREFIX + sectionKey] = iniSectionToJs(item);
    }
  }
  return result;
}

// The values of `merged` that `fragment` does not have: scalars with another
// value and array items beyond the fragment's (the fragment as is keeps only
// the last section's array of a repeated key), in each section too. Both
// come from the same fragment, so every section of `merged` is also in
// `fragment`. A key can still be missing from a section: the fragment as is
// keeps only the last of repeated sections.
export function iniContribDiff(
  fragment: Record<string, unknown>,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    const own = fragment[key];
    if (isPlainObject(value)) {
      const sub = iniContribDiff(own as Record<string, unknown>, value);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else if (Array.isArray(value)) {
      const rest: unknown[] = [...(value as unknown[])];
      removeArrayContribution(rest, Array.isArray(own) ? own : []);
      if (rest.length > 0) out[key] = rest;
    } else if (!deepEqual(own, value)) {
      out[key] = value;
    }
  }
  return out;
}
