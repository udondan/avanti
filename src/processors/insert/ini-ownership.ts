/** Records what an INI insert added (ownership), for the next insert. */
import type {
  IniDocument,
  IniItem,
  IniKeyValue,
  IniScalar,
  IniSection,
} from '../ini';
import { findIniSections, iniScalarId, increment } from './ini-common';
import type { IniOwnedKv, IniOwnership } from './ini-owned';
import {
  copyIniValue,
  forEachIniSection,
  type IniSnapshot,
  type IniValueSnapshot,
} from './ini-snapshot';
import { deepEqual, removeArrayContribution } from './util';

type KvLookup = (node: IniKeyValue) => IniValueSnapshot | undefined;

function ownKv(
  node: IniKeyValue,
  before: IniValueSnapshot | undefined,
): IniOwnedKv | null {
  const owned = {
    key: node.key,
    isArray: node.isArray,
    value: copyIniValue(node.value),
  };
  if (!before || before.isArray !== node.isArray) return owned;
  if (Array.isArray(owned.value)) {
    // Keep only the items the merge added.
    removeArrayContribution(owned.value, before.value as IniScalar[]);
    return owned.value.length > 0 ? owned : null;
  }
  return deepEqual(before.value, node.value) ? null : owned;
}

function markShared(kvs: IniOwnedKv[], shared: Map<string, number>): void {
  for (const kv of kvs) {
    const count = kv.isArray ? 0 : shared.get(iniScalarId(kv.key, kv.value));
    if (count) kv.shared = count;
  }
}

// Returns the owned values, and the keys that had a value before the merge
// and still have one.
function ownKvs(
  items: IniItem[],
  lookup: KvLookup,
): { kvs: IniOwnedKv[]; others: string[] } {
  const kvs: IniOwnedKv[] = [];
  const others = new Set<string>();
  // Scalar nodes the file already had with the same value, by key and value.
  const shared = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== 'kv') continue;
    const before = lookup(it);
    if (before) others.add(it.key);
    const owned = ownKv(it, before);
    if (owned) kvs.push(owned);
    else if (before && !it.isArray)
      increment(shared, iniScalarId(it.key, it.value));
  }
  markShared(kvs, shared);
  return { kvs, others: [...others] };
}

// Matches each value with an unused occurrence of the same key and type.
function unusedKvLookup(recorded: IniOwnedKv[]): KvLookup {
  const unused = [...recorded];
  return (node) => {
    const i = unused.findIndex(
      (kv) =>
        kv.key === node.key &&
        kv.isArray === node.isArray &&
        (kv.isArray || deepEqual(kv.value, node.value)),
    );
    return i === -1 ? undefined : unused.splice(i, 1)[0];
  };
}

// Whether the pull created the section header, and where the values the
// section had before the merge are found.
function sectionOrigin(
  doc: IniDocument,
  snap: IniSnapshot,
  section: IniSection,
  positionKey: string,
): { created: boolean; lookup: KvLookup } {
  const replaced = snap.byPosition.get(positionKey);
  if (!replaced || doc.items.includes(replaced.section)) {
    return {
      created: !snap.sections.has(section),
      lookup: (node) => snap.kvs.get(node),
    };
  }
  // objects: replace swapped the section for a copy of the new one: match each
  // value with an unused occurrence of the same key and type in the section it
  // replaced. The header is added by this pull only if the replaced one was.
  return {
    created: !snap.sections.has(replaced.section),
    lookup: unusedKvLookup(replaced.kvs),
  };
}

// Compares the merged document (mergeIni changes it in place) with the
// snapshot taken before the merge, and returns what the merge added.
export function computeIniOwnership(
  doc: IniDocument,
  snap: IniSnapshot,
): IniOwnership {
  const ownership: IniOwnership = {
    format: 'ini',
    globals: ownKvs(doc.items, (node) => snap.kvs.get(node)).kvs,
    sections: [],
  };
  forEachIniSection(doc, (section, positionKey, index) => {
    const { created, lookup } = sectionOrigin(doc, snap, section, positionKey);
    const { kvs, others } = ownKvs(section.items, lookup);
    if (!created && kvs.length === 0) return;
    ownership.sections.push({
      name: section.name,
      ...(section.subName !== undefined ? { subName: section.subName } : {}),
      index,
      count: findIniSections(doc, section.name, section.subName).length,
      others,
      created,
      kvs,
    });
  });
  return ownership;
}
