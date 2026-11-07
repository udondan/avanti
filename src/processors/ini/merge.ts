// ── Document merge ────────────────────────────────────────────────────────────
import type { IniMergeOptions } from '../../types';
import { findLastIndex } from '../find-last';
import {
  mergeKvIntoItems,
  overlayWins,
  valuesEqual,
  type ResolvedOptions,
} from './merge-kv';
import { parseIniDoc } from './parse';
import { stringifyIniDoc } from './stringify';
import type {
  IniDocument,
  IniItem,
  IniKeyValue,
  IniScalar,
  IniSection,
  IniSectionItem,
} from './types';

function sectionKvsEqual(a: IniSection, b: IniSection): boolean {
  // Compare semantically: the effective value of each key is the last
  // occurrence (INI last-wins). Build key→value maps and compare those,
  // so sections with the same effective keys/values but different ordering
  // or duplicate runs are treated as identical.
  const toEffective = (
    kvs: IniKeyValue[],
  ): Map<string, IniScalar | IniScalar[]> => {
    const m = new Map<string, IniScalar | IniScalar[]>();
    for (const kv of kvs) {
      m.set(`${kv.key}\0${kv.isArray ? '1' : '0'}`, kv.value);
    }
    return m;
  };
  const aKvs = a.items.filter((it): it is IniKeyValue => it.kind === 'kv');
  const bKvs = b.items.filter((it): it is IniKeyValue => it.kind === 'kv');
  const aMap = toEffective(aKvs);
  const bMap = toEffective(bKvs);
  if (aMap.size !== bMap.size) return false;
  for (const [k, aVal] of aMap) {
    const bVal = bMap.get(k);
    if (bVal === undefined || !valuesEqual(aVal, bVal)) return false;
  }
  return true;
}

function mergeSectionItems(
  base: IniSectionItem[],
  overlay: IniSectionItem[],
  opts: ResolvedOptions,
  sectionPath: string,
): void {
  for (const item of overlay) {
    if (item.kind !== 'kv') continue;
    const keyPath = sectionPath ? `${sectionPath}.${item.key}` : item.key;
    mergeKvIntoItems(base, item, opts, keyPath);
  }
}

function mergeGlobalKv(
  base: IniDocument,
  item: IniKeyValue,
  opts: ResolvedOptions,
): void {
  // Global key — find in base globals (items before any section)
  const baseGlobals = base.items.filter(
    (it): it is IniSectionItem => it.kind !== 'section',
  );
  mergeKvIntoItems(baseGlobals, item, opts, item.key);
  // Sync back: mergeKvIntoItems works on the filtered baseGlobals copy, so a
  // newly inserted key lives there but not yet in base.items — add it here.
  // Match by key only (not isArray) so that a first_wins scalar↔array
  // type-change does not incorrectly re-insert the overlay entry alongside
  // the kept base entry, producing duplicate scalar+array lines.
  if (base.items.some((it) => it.kind === 'kv' && it.key === item.key)) return;
  // Insert after the last global KV, or at the section boundary when
  // there are no global KVs — never before leading comment/blank lines.
  const firstSectionIdx = base.items.findIndex((it) => it.kind === 'section');
  const boundary = firstSectionIdx === -1 ? base.items.length : firstSectionIdx;
  const lastKv = findLastIndex(
    base.items,
    (it) => it.kind === 'kv',
    boundary - 1,
  );
  base.items.splice(lastKv === -1 ? boundary : lastKv + 1, 0, { ...item });
}

// Scan from end: INI semantics give the last repeated section the effective
// value.
function findLastSection(items: IniItem[], like: IniSection): number {
  return findLastIndex(
    items,
    (it) =>
      it.kind === 'section' &&
      it.name === like.name &&
      it.subName === like.subName,
  );
}

function sectionPathOf(section: IniSection): string {
  return section.subName !== undefined
    ? `${section.name} "${section.subName}"`
    : section.name;
}

function copySection(section: IniSection): IniSection {
  return { ...section, items: section.items.map((it) => ({ ...it })) };
}

// objects: replace — replace the entire matching section or append.
function replaceSection(
  base: IniDocument,
  item: IniSection,
  opts: ResolvedOptions,
): void {
  const existingIdx = findLastSection(base.items, item);
  if (existingIdx === -1) {
    base.items.push(copySection(item));
    return;
  }
  // Identical sections: no-op.
  if (sectionKvsEqual(base.items[existingIdx] as IniSection, item)) return;
  // Sections differ: apply the same conflict policy used for scalars.
  // Mirrors TOML's behavior where objects:replace falls through to
  // conflict handling when the values are not identical.
  if (overlayWins(opts, sectionPathOf(item))) {
    base.items[existingIdx] = copySection(item);
  }
}

// objects: merge (default) — merge into the last matching section in base,
// or create it.
function mergeSection(
  base: IniDocument,
  item: IniSection,
  opts: ResolvedOptions,
): void {
  const existingIdx = findLastSection(base.items, item);
  if (existingIdx === -1) {
    base.items.push({
      ...item,
      headerComment: undefined,
      items: item.items
        .filter((it) => it.kind === 'kv')
        .map((it) => ({ ...it })),
    });
    return;
  }
  const existing = base.items[existingIdx] as IniSection;
  mergeSectionItems(existing.items, item.items, opts, sectionPathOf(item));
}

function mergeDocuments(
  base: IniDocument,
  overlay: IniDocument,
  opts: ResolvedOptions,
): void {
  for (const item of overlay.items) {
    if (item.kind === 'kv') {
      mergeGlobalKv(base, item, opts);
    } else if (item.kind === 'section') {
      if (opts.objects === 'replace') replaceSection(base, item, opts);
      else mergeSection(base, item, opts);
    }
  }
}

// A part may also be a parsed document, which keeps nodes that have no text of
// their own (empty arrays) at their position.
export function mergeIni(
  parts: (string | IniDocument)[],
  opts: IniMergeOptions = {},
): string {
  const resolved: ResolvedOptions = {
    conflicts: opts.conflicts ?? 'last_wins',
    arrays: opts.arrays ?? 'replace',
    objects: opts.objects ?? 'merge',
  };

  if (parts.length === 0) return '';

  const parsed = parts.map((p, i) => {
    if (typeof p !== 'string') return p;
    try {
      return parseIniDoc(p);
    } catch (e) {
      throw new Error(`[source ${i}]: invalid INI: ${(e as Error).message}`, {
        cause: e,
      });
    }
  });

  const base = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    mergeDocuments(base, parsed[i], resolved);
  }

  return stringifyIniDoc(base);
}
