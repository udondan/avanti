/** Records an INI document's values before the merge. */
import type { IniDocument, IniKeyValue, IniScalar, IniSection } from '../ini';
import { iniSectionKey } from './ini-common';
import type { IniOwnedKv } from './ini-owned';

export type IniValueSnapshot = {
  isArray: boolean;
  value: IniScalar | IniScalar[];
};

export interface IniSnapshot {
  kvs: Map<IniKeyValue, IniValueSnapshot>;
  sections: Set<IniSection>;
  // Sections by name and position, so a section that objects: replace swapped
  // for a new object is matched with the one it replaced.
  byPosition: Map<string, { section: IniSection; kvs: IniOwnedKv[] }>;
}

export function copyIniValue(
  v: IniScalar | IniScalar[],
): IniScalar | IniScalar[] {
  return Array.isArray(v) ? [...v] : v;
}

export function emptyIniSnapshot(): IniSnapshot {
  return { kvs: new Map(), sections: new Set(), byPosition: new Map() };
}

// Calls `fn` for every section with its position among the sections that
// share its name.
export function forEachIniSection(
  doc: IniDocument,
  fn: (section: IniSection, positionKey: string, index: number) => void,
): void {
  const seen = new Map<string, number>();
  for (const item of doc.items) {
    if (item.kind !== 'section') continue;
    const sectionKey = iniSectionKey(item.name, item.subName);
    const index = seen.get(sectionKey) ?? 0;
    seen.set(sectionKey, index + 1);
    fn(item, `${sectionKey}\0${index}`, index);
  }
}

// Records every node and its value before the merge. Nodes in `kept` held the
// previous contribution and were left in place for the merge to refill, so
// they count as added by this pull.
export function snapshotIni(
  doc: IniDocument,
  kept: ReadonlySet<object>,
): IniSnapshot {
  const snap = emptyIniSnapshot();
  const record = (node: IniKeyValue): IniValueSnapshot | null => {
    if (kept.has(node)) return null;
    const value = { isArray: node.isArray, value: copyIniValue(node.value) };
    snap.kvs.set(node, value);
    return value;
  };
  for (const item of doc.items) if (item.kind === 'kv') record(item);
  forEachIniSection(doc, (section, positionKey) => {
    const kvs: IniOwnedKv[] = [];
    for (const child of section.items) {
      if (child.kind !== 'kv') continue;
      const value = record(child);
      if (value) kvs.push({ key: child.key, ...value });
    }
    // A kept section is one the previous pull created; its header still
    // counts as added by this pull, but its values are recorded as usual.
    if (!kept.has(section)) snap.sections.add(section);
    snap.byPosition.set(positionKey, { section, kvs });
  });
  return snap;
}
