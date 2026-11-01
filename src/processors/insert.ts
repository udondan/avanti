import * as fs from 'fs';
import { parse as parseJson, stringify as stringifyJson } from 'comment-json';
import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Pair,
  type YAMLMap,
} from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { FileEntry, FileSrc } from '../types';
import { mergeJson } from './json';
import { mergeYaml } from './yaml';
import { mergeToml } from './toml';
import {
  parseIniDoc,
  mergeIni,
  type IniDocument,
  type IniItem,
  type IniKeyValue,
  type IniSection,
  type IniScalar,
  type IniComment,
  type IniBlank,
} from './ini';
import {
  resolveJsonOptions,
  resolveYamlOptions,
  resolveTomlOptions,
  resolveIniOptions,
} from '../sources';

// ── Utilities ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function sortedStringify(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map(sortedStringify).join(',') + ']';
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
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

function deepEqual(a: unknown, b: unknown): boolean {
  return sortedStringify(a) === sortedStringify(b);
}

// ── JSON removal (comment-json, preserves comments on retained keys) ─────────

type CommentJsonValue = ReturnType<typeof parseJson>;

function deepRemoveFromJsonObj(
  existing: Record<string, CommentJsonValue>,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null = null,
): void {
  for (const key of Object.keys(oldContrib)) {
    if (!Object.hasOwn(existing, key)) continue;
    const oldVal = oldContrib[key];
    const curVal = existing[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (isPlainObject(oldVal) && isPlainObject(curVal)) {
      const nestedNew = isPlainObject(newVal) ? newVal : null;
      deepRemoveFromJsonObj(curVal, oldVal, nestedNew);
      if (Object.keys(curVal).length === 0 && newVal === undefined) {
        delete existing[key];
      }
    } else if (Array.isArray(oldVal) && Array.isArray(curVal)) {
      removeArrayContribution(curVal, oldVal);
      if (curVal.length === 0 && newVal === undefined) {
        delete existing[key];
      }
    } else {
      if (newVal !== undefined) continue;
      if (deepEqual(curVal, oldVal)) {
        delete existing[key];
      }
    }
  }
}

// ── YAML removal (yaml AST, preserves comments on retained keys) ─────────────

function yamlPairKey(pair: Pair): string {
  if (isScalar(pair.key)) return String((pair.key as { value: unknown }).value);
  return String(pair.key);
}

function yamlNodeToJs(node: unknown): unknown {
  if (
    node !== null &&
    typeof node === 'object' &&
    typeof (node as Record<string, unknown>)['toJSON'] === 'function'
  ) {
    return (node as { toJSON(): unknown }).toJSON();
  }
  return node;
}

function deepRemoveFromYamlMap(
  base: YAMLMap,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null = null,
): void {
  for (const key of Object.keys(oldContrib)) {
    const pairIdx = base.items.findIndex((p) => yamlPairKey(p) === key);
    if (pairIdx === -1) continue;

    const pair = base.items[pairIdx];
    const oldVal = oldContrib[key];
    const pairVal = pair.value;
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (isPlainObject(oldVal) && isMap(pairVal)) {
      const nestedNew = isPlainObject(newVal) ? newVal : null;
      deepRemoveFromYamlMap(pairVal, oldVal, nestedNew);
      if (
        (pairVal as { items: unknown[] }).items.length === 0 &&
        newVal === undefined
      ) {
        base.items.splice(pairIdx, 1);
      }
    } else if (Array.isArray(oldVal) && isSeq(pairVal)) {
      const seqItems = (pairVal as { items: unknown[] }).items;
      removeArrayContribution(seqItems, oldVal, (item) => yamlNodeToJs(item));
      if (seqItems.length === 0 && newVal === undefined) {
        base.items.splice(pairIdx, 1);
      }
    } else {
      if (newVal !== undefined) continue;
      if (deepEqual(yamlNodeToJs(pairVal), oldVal)) {
        base.items.splice(pairIdx, 1);
      }
    }
  }
}

// ── TOML removal (plain objects) ─────────────────────────────────────────────

type TomlObject = Record<string, unknown>;

function deepRemoveFromTomlObj(
  existing: TomlObject,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null = null,
): void {
  for (const key of Object.keys(oldContrib)) {
    if (!Object.hasOwn(existing, key)) continue;
    const oldVal = oldContrib[key];
    const curVal = existing[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (isPlainObject(oldVal) && isPlainObject(curVal)) {
      const nestedNew = isPlainObject(newVal) ? newVal : null;
      deepRemoveFromTomlObj(curVal, oldVal, nestedNew);
      if (Object.keys(curVal).length === 0 && newVal === undefined) {
        delete existing[key];
      }
    } else if (Array.isArray(oldVal) && Array.isArray(curVal)) {
      removeArrayContribution(curVal, oldVal);
      if (curVal.length === 0 && newVal === undefined) {
        delete existing[key];
      }
    } else {
      if (newVal !== undefined) continue;
      if (deepEqual(curVal, oldVal)) {
        delete existing[key];
      }
    }
  }
}

// ── Array contribution removal (searching from end) ──────────────────────────

function removeArrayContribution(
  existing: unknown[],
  oldItems: unknown[],
  toJs: (item: unknown) => unknown = (x) => x,
): unknown[] {
  // Returns the old items that were not found, in their original order.
  const notFound: unknown[] = [];
  for (let i = oldItems.length - 1; i >= 0; i--) {
    const target = oldItems[i];
    let found = false;
    for (let j = existing.length - 1; j >= 0; j--) {
      if (deepEqual(toJs(existing[j]), target)) {
        existing.splice(j, 1);
        found = true;
        break;
      }
    }
    if (!found) notFound.unshift(target);
  }
  return notFound;
}

// ── INI removal (AST, preserves comments on retained keys) ───────────────────

type IniSectionItems = (IniComment | IniBlank | IniKeyValue)[];

// Remove contiguous comment/blank nodes immediately preceding `idx` in `items`.
// Stops when it reaches a kv or section boundary, preventing unrelated comments
// from being stripped. Call this after splicing a kv node to avoid leaving
// orphaned comments that would appear to annotate the next key.
function splicePrecedingCommentBlanks(items: IniItem[], idx: number): void {
  let k = idx - 1;
  while (k >= 0 && (items[k].kind === 'comment' || items[k].kind === 'blank')) {
    items.splice(k, 1);
    k--;
  }
}

function spliceIniNode(items: IniSectionItems, node: IniKeyValue): void {
  const idx = items.indexOf(node);
  items.splice(idx, 1);
  splicePrecedingCommentBlanks(items, idx);
}

// Finds all sections with this name, in file order. A file may repeat a
// section; mergeIni merges into the last one.
function findIniSections(
  doc: IniDocument,
  name: string,
  subName: string | undefined,
): IniSection[] {
  return doc.items.filter(
    (it): it is IniSection =>
      it.kind === 'section' && it.name === name && it.subName === subName,
  );
}

function iniSectionKey(name: string, subName: string | undefined): string {
  return subName !== undefined ? `${name} "${subName}"` : name;
}

// Removes the given sections when they have no key/value pairs left. The last
// section is kept instead when `keepEffective` is set, so the merge refills it
// in place; it is then added to `kept`.
function removeEmptiedSections(
  doc: IniDocument,
  sections: Iterable<IniSection>,
  effective: IniSection,
  keepEffective: boolean,
  kept: Set<object>,
): void {
  for (const section of sections) {
    if (section.items.some((it) => it.kind === 'kv')) continue;
    if (section === effective && keepEffective) {
      kept.add(section);
      continue;
    }
    // Do not strip preceding comment/blank nodes at the doc level —
    // they may be file-level separators unrelated to this section.
    doc.items.splice(doc.items.indexOf(section), 1);
  }
}

// Removes the old contribution from the given sections, searched in the given
// order. Only in `effective` (the last section with that name, the one
// mergeIni merges into) may nodes stay in place for the merge to refill; those
// nodes are added to `kept`. Returns the sections that had something removed.
function deepRemoveFromIniSections(
  searchOrder: IniSection[],
  effective: IniSection,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
  kept: Set<object>,
): Set<IniSection> {
  const touched = new Set<IniSection>();
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (Array.isArray(oldVal)) {
      // iniDocToJs prefixes every array key, so the prefix is always present.
      const iniKey = key.slice(INI_ARRAY_PREFIX.length);
      const matches: { section: IniSection; node: IniKeyValue }[] = [];
      for (const section of searchOrder) {
        const items = section.items;
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j];
          if (it.kind === 'kv' && it.key === iniKey && it.isArray) {
            matches.push({ section, node: it });
          }
        }
      }
      let remaining: unknown[] = oldVal;
      for (const { section, node } of matches) {
        if (remaining.length === 0) break;
        const curArr = node.value as IniScalar[];
        const before = curArr.length;
        remaining = removeArrayContribution(curArr, remaining);
        if (curArr.length === before) continue;
        touched.add(section);
        // An empty node in the last section stays in place when the key is
        // still an array, so mergeIni refills it at the same position.
        // Otherwise (key removed, type changed to scalar, or an earlier
        // section the merge never writes to) the node is dropped.
        if (
          curArr.length === 0 &&
          !(section === effective && Array.isArray(newVal))
        ) {
          spliceIniNode(section.items, node);
        }
      }
    } else {
      // The last node wins in INI, so only that one is compared.
      let match: { section: IniSection; node: IniKeyValue } | undefined;
      for (const section of searchOrder) {
        const items = section.items;
        for (let j = items.length - 1; j >= 0 && !match; j--) {
          const it = items[j];
          if (it.kind === 'kv' && it.key === key && !it.isArray) {
            match = { section, node: it };
          }
        }
        if (match) break;
      }
      if (!match) continue;
      // Skip only when the node is in the last section and newVal is the same
      // scalar type, so mergeIni updates it in place. Otherwise remove it:
      // the merge writes the new shape or value into the last section.
      if (
        match.section === effective &&
        newVal !== undefined &&
        !Array.isArray(newVal)
      ) {
        if (deepEqual(match.node.value, oldVal)) kept.add(match.node);
        continue;
      }
      if (deepEqual(match.node.value, oldVal)) {
        spliceIniNode(match.section.items, match.node);
        touched.add(match.section);
      }
    }
  }
  return touched;
}

// Removes an old global (doc-level) value. Global keys come before the first
// section, so they cannot repeat across sections.
function removeIniGlobal(
  doc: IniDocument,
  key: string,
  oldVal: unknown,
  newVal: unknown,
  kept: Set<object>,
): void {
  const isArray = Array.isArray(oldVal);
  // iniDocToJs prefixes every array key, so the prefix is always present.
  const iniKey = isArray ? key.slice(INI_ARRAY_PREFIX.length) : key;
  let node: IniKeyValue | undefined;
  for (let j = doc.items.length - 1; j >= 0; j--) {
    const it = doc.items[j];
    if (it.kind === 'kv' && it.key === iniKey && it.isArray === isArray) {
      node = it;
      break;
    }
  }
  if (!node) return;
  if (isArray) {
    const curArr = node.value as IniScalar[];
    removeArrayContribution(curArr, oldVal as unknown[]);
    // An emptied node stays in place when the key is still an array, so the
    // merge refills it at the same position. Otherwise drop it. Do not strip
    // preceding comment/blank nodes at the doc level.
    if (curArr.length === 0 && !Array.isArray(newVal)) {
      doc.items.splice(doc.items.indexOf(node), 1);
    }
    return;
  }
  // Skip only when newVal is the same scalar type; remove the old node
  // when type changes to array or section so the merge can re-add it.
  if (
    newVal !== undefined &&
    !Array.isArray(newVal) &&
    !isPlainObject(newVal)
  ) {
    if (deepEqual(node.value, oldVal)) kept.add(node);
    return;
  }
  if (deepEqual(node.value, oldVal)) {
    // Do not strip preceding comment/blank nodes at the doc level.
    doc.items.splice(doc.items.indexOf(node), 1);
  }
}

// Removes an old contribution that is only known as the text of the fragment
// (history written before ownership tracking). Values are searched in every
// section with a matching name.
function deepRemoveFromIniDoc(
  doc: IniDocument,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
  newKeys: ReadonlySet<string>,
  kept: Set<object>,
): void {
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (!isPlainObject(oldVal)) {
      removeIniGlobal(doc, key, oldVal, newVal, kept);
      continue;
    }
    // iniDocToJs prefixes every section key, so the prefix is always present.
    const sectionKey = key.slice(INI_SECTION_PREFIX.length);
    const subsectionMatch = /^(.+?)\s+"([^"]*)"$/.exec(sectionKey);
    const sections = subsectionMatch
      ? findIniSections(doc, subsectionMatch[1], subsectionMatch[2])
      : findIniSections(doc, sectionKey, undefined);
    if (sections.length === 0) continue;
    const effective = sections[sections.length - 1];
    const nestedNew = isPlainObject(newVal) ? newVal : null;
    const touched = deepRemoveFromIniSections(
      [...sections].reverse(),
      effective,
      oldVal,
      nestedNew,
      kept,
    );
    // A contributed section without keys was written into the last section.
    if (Object.keys(oldVal).length === 0) touched.add(effective);
    // The last section stays when the new contribution still has it (under
    // any conflict strategy), so the merge refills it in place. Sections
    // nothing was removed from are never removed.
    removeEmptiedSections(doc, touched, effective, newKeys.has(key), kept);
  }
}

// ── INI ownership (what each pull added) ─────────────────────────────────────

interface IniOwnedKv {
  key: string;
  isArray: boolean;
  value: IniScalar | IniScalar[];
}

interface IniOwnedSection {
  name: string;
  subName?: string;
  // Position among the sections with the same name, counted from the start.
  index: number;
  // How many sections had this name; the position is only trusted while the
  // file still has that many.
  count: number;
  // Keys the section had before the pull. They tell a section apart from a
  // user section that happens to hold the same values.
  others: string[];
  // True when the pull added the section itself, not only values in it.
  created: boolean;
  kvs: IniOwnedKv[];
}

interface IniOwnership {
  format: 'ini';
  globals: IniOwnedKv[];
  sections: IniOwnedSection[];
}

function isIniOwnedKvList(v: unknown): v is IniOwnedKv[] {
  return (
    Array.isArray(v) &&
    v.every(
      (kv) =>
        isPlainObject(kv) &&
        typeof kv['key'] === 'string' &&
        typeof kv['isArray'] === 'boolean' &&
        (kv['isArray']
          ? Array.isArray(kv['value'])
          : kv['value'] !== undefined),
    )
  );
}

function isIniOwnership(v: unknown): v is IniOwnership {
  return (
    isPlainObject(v) &&
    v['format'] === 'ini' &&
    isIniOwnedKvList(v['globals']) &&
    Array.isArray(v['sections']) &&
    v['sections'].every(
      (s) =>
        isPlainObject(s) &&
        typeof s['name'] === 'string' &&
        (s['subName'] === undefined || typeof s['subName'] === 'string') &&
        typeof s['index'] === 'number' &&
        typeof s['count'] === 'number' &&
        Array.isArray(s['others']) &&
        s['others'].every((k) => typeof k === 'string') &&
        typeof s['created'] === 'boolean' &&
        isIniOwnedKvList(s['kvs']),
    )
  );
}

type IniValueSnapshot = { isArray: boolean; value: IniScalar | IniScalar[] };

interface IniSnapshot {
  kvs: Map<IniKeyValue, IniValueSnapshot>;
  sections: Set<IniSection>;
  // Sections by name and position, so a section that objects: replace swapped
  // for a new object is matched with the one it replaced.
  byPosition: Map<string, { section: IniSection; kvs: IniOwnedKv[] }>;
}

function copyIniValue(v: IniScalar | IniScalar[]): IniScalar | IniScalar[] {
  return Array.isArray(v) ? [...v] : v;
}

function emptyIniSnapshot(): IniSnapshot {
  return { kvs: new Map(), sections: new Set(), byPosition: new Map() };
}

// Calls `fn` for every section with its position among the sections that
// share its name.
function forEachIniSection(
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
function snapshotIni(doc: IniDocument, kept: ReadonlySet<object>): IniSnapshot {
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

// Compares the merged document (mergeIni changes it in place) with the
// snapshot taken before the merge, and returns what the merge added.
function computeIniOwnership(
  doc: IniDocument,
  snap: IniSnapshot,
): IniOwnership {
  const ownKv = (
    node: IniKeyValue,
    before: IniValueSnapshot | undefined,
  ): IniOwnedKv | null => {
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
  };
  // Returns the owned values, and the keys that had a value before the merge
  // and still have one.
  const ownKvs = (
    items: IniItem[],
    lookup: (node: IniKeyValue) => IniValueSnapshot | undefined,
  ): { kvs: IniOwnedKv[]; others: string[] } => {
    const kvs: IniOwnedKv[] = [];
    const others = new Set<string>();
    for (const it of items) {
      if (it.kind !== 'kv') continue;
      const before = lookup(it);
      if (before) others.add(it.key);
      const owned = ownKv(it, before);
      if (owned) kvs.push(owned);
    }
    return { kvs, others: [...others] };
  };
  const byIdentity = (node: IniKeyValue) => snap.kvs.get(node);

  const ownership: IniOwnership = {
    format: 'ini',
    globals: ownKvs(doc.items, byIdentity).kvs,
    sections: [],
  };
  const counts = new Map<string, number>();
  forEachIniSection(doc, (section) => {
    const sectionKey = iniSectionKey(section.name, section.subName);
    counts.set(sectionKey, (counts.get(sectionKey) ?? 0) + 1);
  });
  forEachIniSection(doc, (section, positionKey, index) => {
    let created = !snap.sections.has(section);
    let lookup = byIdentity;
    const replaced = snap.byPosition.get(positionKey);
    if (replaced && !doc.items.includes(replaced.section)) {
      // objects: replace swapped the section for a copy of the new one:
      // match each value with an unused occurrence of the same key and type
      // in the section it replaced. The header is added by this pull only if
      // the replaced one was.
      created = !snap.sections.has(replaced.section);
      const unused = [...replaced.kvs];
      lookup = (node) => {
        const i = unused.findIndex(
          (kv) =>
            kv.key === node.key &&
            kv.isArray === node.isArray &&
            (kv.isArray || deepEqual(kv.value, node.value)),
        );
        return i === -1 ? undefined : unused.splice(i, 1)[0];
      };
    }
    const { kvs, others } = ownKvs(section.items, lookup);
    if (!created && kvs.length === 0) return;
    ownership.sections.push({
      name: section.name,
      ...(section.subName !== undefined ? { subName: section.subName } : {}),
      index,
      count: counts.get(iniSectionKey(section.name, section.subName))!,
      others,
      created,
      kvs,
    });
  });
  return ownership;
}

// Converts owned values to the shape iniDocToJs produces. The parser keeps
// one node per array key, but a scalar key may repeat: only its last
// occurrence goes into the object, the earlier ones are returned separately.
function iniOwnedToContrib(kvs: IniOwnedKv[]): {
  contrib: Record<string, unknown>;
  earlier: IniOwnedKv[];
} {
  const contrib: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const earlier: IniOwnedKv[] = [];
  const last = new Map<string, IniOwnedKv>();
  for (const kv of kvs) {
    if (kv.isArray) {
      // A section may hold more than one node for an array key.
      const arrayKey = INI_ARRAY_PREFIX + kv.key;
      contrib[arrayKey] = [
        ...((contrib[arrayKey] as IniScalar[] | undefined) ?? []),
        ...(kv.value as IniScalar[]),
      ];
      continue;
    }
    const prev = last.get(kv.key);
    if (prev) earlier.push(prev);
    last.set(kv.key, kv);
    contrib[kv.key] = kv.value;
  }
  return { contrib, earlier };
}

// Removes earlier occurrences of repeated scalar keys, each once, searching
// from the end. Nodes kept for the merge to refill are skipped.
function removeEarlierIniScalars(
  items: IniItem[],
  earlier: IniOwnedKv[],
  kept: ReadonlySet<object>,
  stripComments: boolean,
): void {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const { key, value } = earlier[i];
    for (let j = items.length - 1; j >= 0; j--) {
      const it = items[j];
      if (
        it.kind === 'kv' &&
        it.key === key &&
        !it.isArray &&
        !kept.has(it) &&
        deepEqual(it.value, value)
      ) {
        items.splice(j, 1);
        if (stripComments) splicePrecedingCommentBlanks(items, j);
        break;
      }
    }
  }
}

// The last node of a key is the one that counts in INI, and the normal removal
// only looks at that one. When it is not the owned value (a later occurrence
// belongs to the user), the owned value is an earlier occurrence: move it to
// `earlier` so it is removed on its own and the user's value stays.
function moveShadowedIniScalars(
  items: IniItem[],
  owned: { contrib: Record<string, unknown>; earlier: IniOwnedKv[] },
): void {
  for (const key of Object.keys(owned.contrib)) {
    const value = owned.contrib[key];
    if (Array.isArray(value)) continue;
    let last: IniKeyValue | undefined;
    for (const it of items) {
      if (it.kind === 'kv' && it.key === key && !it.isArray) last = it;
    }
    if (last && !deepEqual(last.value, value)) {
      delete owned.contrib[key];
      owned.earlier.push({ key, isArray: false, value: value as IniScalar });
    }
  }
}

// True when the section still holds every owned value. Each owned scalar
// needs its own node and each owned array item its own item, so repeated
// values are not matched twice by the same node or item.
function iniSectionHolds(section: IniSection, kvs: IniOwnedKv[]): boolean {
  const used = new Set<IniKeyValue>();
  const rest = new Map<IniKeyValue, IniScalar[]>();
  return kvs.every((kv) =>
    section.items.some((it) => {
      if (it.kind !== 'kv' || it.key !== kv.key || it.isArray !== kv.isArray)
        return false;
      if (!kv.isArray) {
        if (used.has(it) || !deepEqual(it.value, kv.value)) return false;
        used.add(it);
        return true;
      }
      const items = [...(rest.get(it) ?? (it.value as IniScalar[]))];
      if (removeArrayContribution(items, kv.value as IniScalar[]).length > 0)
        return false;
      rest.set(it, items);
      return true;
    }),
  );
}

// Finds the section an owned entry refers to. The recorded position is used
// while the file has as many sections with that name as when it was written.
// Otherwise the one section that still holds all owned values is used, and
// nothing when that is missing or ambiguous.
function resolveOwnedIniSection(
  group: IniSection[],
  s: IniOwnedSection,
): IniSection | undefined {
  if (group.length === s.count) return group[s.index];
  if (s.kvs.length === 0) return undefined;
  const candidates = group.filter(
    (section) =>
      iniSectionHolds(section, s.kvs) &&
      s.others.every((key) =>
        section.items.some((it) => it.kind === 'kv' && it.key === key),
      ),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

// Removes exactly what the previous pull added. Values the file already had
// are left alone, and only sections the pull created are removed.
function removeIniOwnership(
  doc: IniDocument,
  owned: IniOwnership,
  newContrib: Record<string, unknown> | null,
  newKeys: ReadonlySet<string>,
  kept: Set<object>,
): void {
  const globals = iniOwnedToContrib(owned.globals);
  moveShadowedIniScalars(doc.items, globals);
  for (const key of Object.keys(globals.contrib)) {
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;
    removeIniGlobal(doc, key, globals.contrib[key], newVal, kept);
  }
  // Do not strip preceding comment/blank nodes at the doc level.
  removeEarlierIniScalars(doc.items, globals.earlier, kept, false);

  // Find every target before changing anything: removing a section shifts
  // the positions of the ones after it.
  const resolved = owned.sections.flatMap((s) => {
    const group = findIniSections(doc, s.name, s.subName);
    const target = resolveOwnedIniSection(group, s);
    return target ? [{ s, target, effective: group[group.length - 1] }] : [];
  });
  // When several owned entries match the same section (the user merged or
  // removed sections), it is unclear which values are ours: skip them all.
  const claims = new Map<IniSection, number>();
  for (const { target } of resolved) {
    claims.set(target, (claims.get(target) ?? 0) + 1);
  }
  const targets = resolved.filter(({ target }) => claims.get(target) === 1);
  for (const { s, target, effective } of targets) {
    const jsKey = INI_SECTION_PREFIX + iniSectionKey(s.name, s.subName);
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, jsKey)
        ? newContrib[jsKey]
        : undefined;
    const sectionOwned = iniOwnedToContrib(s.kvs);
    moveShadowedIniScalars(target.items, sectionOwned);
    const { contrib, earlier } = sectionOwned;
    deepRemoveFromIniSections(
      [target],
      effective,
      contrib,
      isPlainObject(newVal) ? newVal : null,
      kept,
    );
    removeEarlierIniScalars(target.items, earlier, kept, true);
    if (s.created) {
      removeEmptiedSections(doc, [target], effective, newKeys.has(jsKey), kept);
      // A created section that stays is still one this pull added.
      kept.add(target);
    }
  }
}

// Sentinel prefix for section keys in the JS representation so that a global
// key named "db" and a section named [db] never collide in the same object.
// Real INI keys cannot contain null bytes, making this unambiguous.
const INI_SECTION_PREFIX = '\0s:';
// Sentinel prefix for array KV keys (key[] = val) so they never collide with
// a scalar KV of the same name (key = val) in the same JS object.
const INI_ARRAY_PREFIX = '\0a:';

function iniDocToJs(doc: IniDocument): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const item of doc.items) {
    if (item.kind === 'kv') {
      const jsKey = item.isArray ? INI_ARRAY_PREFIX + item.key : item.key;
      result[jsKey] = item.value;
    } else if (item.kind === 'section') {
      const sectionKey =
        item.subName !== undefined
          ? `${item.name} "${item.subName}"`
          : item.name;
      const obj: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const child of item.items) {
        if (child.kind === 'kv') {
          const jsKey = child.isArray
            ? INI_ARRAY_PREFIX + child.key
            : child.key;
          obj[jsKey] = child.value;
        }
      }
      result[INI_SECTION_PREFIX + sectionKey] = obj;
    }
  }
  return result;
}

// ── Structured insert helpers ─────────────────────────────────────────────────

function applyJsonInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  let cleanedJson: string;
  if (lastProcessed !== null) {
    let existingParsed: Record<string, CommentJsonValue>;
    try {
      existingParsed = parseJson(existingContent) as Record<
        string,
        CommentJsonValue
      >;
    } catch (err) {
      throw new Error(
        `insert mode: existing file is not valid JSON/JSONC: ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      const oldContrib = parseJson(lastProcessed) as Record<string, unknown>;
      if (isPlainObject(existingParsed) && isPlainObject(oldContrib)) {
        // Order-preservation only works under last_wins; with first_wins the
        // stale key would persist, and with abort mergeJson would throw on
        // the un-removed key.
        const rawConflicts = opts['conflicts'];
        const effectiveConflicts =
          rawConflicts === 'abort' || rawConflicts === 'first_wins'
            ? rawConflicts
            : 'last_wins';
        let newContrib: Record<string, unknown> | null = null;
        if (effectiveConflicts === 'last_wins') {
          try {
            const p = parseJson(processedText);
            if (isPlainObject(p)) newContrib = p;
          } catch {
            // unparseable processedText → null (old behaviour)
          }
        }
        deepRemoveFromJsonObj(existingParsed, oldContrib, newContrib);
      }
    } catch {
      // Corrupted history fragment — skip key removal, fall through to merge
    }
    cleanedJson = stringifyJson(existingParsed, null, 2);
  } else {
    cleanedJson = existingContent;
  }
  return mergeJson([cleanedJson, processedText], opts);
}

function applyYamlInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  let cleanedYaml: string;
  if (lastProcessed !== null) {
    const doc = parseDocument(existingContent);
    if (doc.errors.length > 0) {
      throw new Error(
        `insert mode: existing file is not valid YAML: ${doc.errors[0].message}`,
        { cause: doc.errors[0] },
      );
    }
    if (isMap(doc.contents)) {
      const lpDoc = parseDocument(lastProcessed);
      if (lpDoc.errors.length === 0) {
        const oldContrib = lpDoc.toJSON() as Record<string, unknown>;
        if (isPlainObject(oldContrib)) {
          // Order-preservation only works under last_wins; with first_wins the
          // stale key would persist, and with abort mergeYaml would throw on
          // the un-removed key.
          const rawConflicts = opts['conflicts'];
          const effectiveConflicts =
            rawConflicts === 'abort' || rawConflicts === 'first_wins'
              ? rawConflicts
              : 'last_wins';
          let newContrib: Record<string, unknown> | null = null;
          if (effectiveConflicts === 'last_wins') {
            try {
              const ptDoc = parseDocument(processedText);
              if (ptDoc.errors.length === 0) {
                const p = ptDoc.toJSON() as unknown;
                if (isPlainObject(p)) newContrib = p;
              }
            } catch {
              // unparseable processedText → null (old behaviour)
            }
          }
          deepRemoveFromYamlMap(doc.contents, oldContrib, newContrib);
        }
      }
    }
    cleanedYaml = doc.toString();
  } else {
    cleanedYaml = existingContent;
  }
  return mergeYaml([cleanedYaml, processedText], opts);
}

function applyTomlInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  let cleanedToml: string;
  if (lastProcessed !== null) {
    let existingParsed: TomlObject;
    try {
      existingParsed = parseToml(existingContent);
    } catch (err) {
      throw new Error(
        `insert mode: existing file is not valid TOML: ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      const oldContrib = parseToml(lastProcessed) as Record<string, unknown>;
      // Order-preservation only works under last_wins; with first_wins the
      // stale key would persist, and with abort mergeToml would throw on
      // the un-removed key.
      const rawConflicts = opts['conflicts'];
      const effectiveConflicts =
        rawConflicts === 'abort' || rawConflicts === 'first_wins'
          ? rawConflicts
          : 'last_wins';
      let newContrib: Record<string, unknown> | null = null;
      if (effectiveConflicts === 'last_wins') {
        try {
          const p = parseToml(processedText);
          if (isPlainObject(p)) newContrib = p;
        } catch {
          // unparseable processedText → null (old behaviour)
        }
      }
      deepRemoveFromTomlObj(existingParsed, oldContrib, newContrib);
    } catch {
      // Corrupted history fragment — skip key removal, fall through to merge
    }
    cleanedToml = stringifyToml(existingParsed);
  } else {
    cleanedToml = existingContent;
  }
  return mergeToml([cleanedToml, processedText], opts);
}

function applyIniInsert(
  existingContent: string,
  processedText: string,
  last: InsertHistory | null,
  opts: Record<string, unknown>,
): InsertResult {
  let doc: IniDocument;
  try {
    doc = parseIniDoc(existingContent);
  } catch (err) {
    throw new Error(
      `insert mode: existing file is not valid INI: ${(err as Error).message}`,
      { cause: err },
    );
  }
  // Nodes that held the previous contribution and stay for the merge to refill.
  const kept = new Set<object>();
  if (last !== null) {
    try {
      // Order-preservation only works under last_wins; with first_wins the
      // stale key would persist, and with abort mergeIni would throw on
      // the un-removed key.
      const rawConflicts = opts['conflicts'];
      const effectiveConflicts =
        rawConflicts === 'abort' || rawConflicts === 'first_wins'
          ? rawConflicts
          : 'last_wins';
      let newParsed: Record<string, unknown> = {};
      try {
        newParsed = iniDocToJs(parseIniDoc(processedText));
      } catch {
        // unparseable processedText → no new keys (old behaviour)
      }
      const newContrib = effectiveConflicts === 'last_wins' ? newParsed : null;
      // Keys whose emptied last section may stay for the merge to refill:
      // under any conflict strategy, except with objects: replace, where an
      // empty section would conflict with the new one instead of being filled.
      const newKeys = new Set(
        Object.keys(
          opts['objects'] === 'replace' ? (newContrib ?? {}) : newParsed,
        ),
      );
      if (isIniOwnership(last.owned)) {
        removeIniOwnership(doc, last.owned, newContrib, newKeys, kept);
      } else {
        // Older history only has the fragment text. Merge it into an empty
        // file with the same options, so repeated sections in it collapse to
        // the values that were written.
        const oldDoc = parseIniDoc(mergeIni(['', last.processed], opts));
        const oldContrib = iniDocToJs(oldDoc);
        deepRemoveFromIniDoc(doc, oldContrib, newContrib, newKeys, kept);
      }
    } catch {
      // Corrupted history fragment — skip key removal, fall through to merge
    }
  }
  const snap = snapshotIni(doc, kept);
  // Passed as a document, so emptied array nodes keep their position and the
  // merge changes `doc` in place.
  const text = mergeIni([doc, processedText], opts);
  return { text, owned: computeIniOwnership(doc, snap) };
}

// What a missing target gets: the contribution is written as is, so all of
// it is owned.
function iniOwnershipOfNewFile(
  processedText: string,
): IniOwnership | undefined {
  try {
    const doc = parseIniDoc(processedText);
    return computeIniOwnership(doc, emptyIniSnapshot());
  } catch {
    return undefined;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** What history knows about the previous insert into a file. */
export interface InsertHistory {
  /** The processed fragment that was inserted. */
  processed: string;
  /** What the insert added, when the format tracks it (INI). */
  owned?: unknown;
}

export interface InsertResult {
  text: string;
  /** What this insert added; store it in history for the next insert. */
  owned?: unknown;
}

export function applyInsertMode(
  entry: FileEntry,
  processedText: string,
  lastProcessed: string | null,
  targetPath: string,
): string {
  return applyInsertModeTracked(
    entry,
    processedText,
    lastProcessed === null ? null : { processed: lastProcessed },
    targetPath,
  ).text;
}

export function applyInsertModeTracked(
  entry: FileEntry,
  processedText: string,
  last: InsertHistory | null,
  targetPath: string,
): InsertResult {
  const lastProcessed = last?.processed ?? null;
  const srcs: FileSrc[] = Array.isArray(entry.src) ? entry.src : [entry.src];

  const jsonOpts = resolveJsonOptions(entry, srcs);
  const yamlOpts = jsonOpts === null ? resolveYamlOptions(entry, srcs) : null;
  const tomlOpts =
    jsonOpts === null && yamlOpts === null
      ? resolveTomlOptions(entry, srcs)
      : null;
  const iniOpts =
    jsonOpts === null && yamlOpts === null && tomlOpts === null
      ? resolveIniOptions(entry, srcs)
      : null;

  if (!fs.existsSync(targetPath)) {
    return {
      text: processedText,
      ...(iniOpts !== null
        ? { owned: iniOwnershipOfNewFile(processedText) }
        : {}),
    };
  }
  const existingContent = fs.readFileSync(targetPath, 'utf8');

  if (jsonOpts !== null) {
    return {
      text: applyJsonInsert(
        existingContent,
        processedText,
        lastProcessed,
        jsonOpts as Record<string, unknown>,
      ),
    };
  }
  if (yamlOpts !== null) {
    return {
      text: applyYamlInsert(
        existingContent,
        processedText,
        lastProcessed,
        yamlOpts as Record<string, unknown>,
      ),
    };
  }
  if (tomlOpts !== null) {
    return {
      text: applyTomlInsert(
        existingContent,
        processedText,
        lastProcessed,
        tomlOpts as Record<string, unknown>,
      ),
    };
  }
  if (iniOpts !== null) {
    return applyIniInsert(
      existingContent,
      processedText,
      last,
      iniOpts as Record<string, unknown>,
    );
  }

  // Plain text: find old fragment in file and replace; otherwise append
  if (
    lastProcessed !== null &&
    lastProcessed.length > 0 &&
    existingContent.includes(lastProcessed)
  ) {
    const idx = existingContent.lastIndexOf(lastProcessed);
    return {
      text:
        existingContent.slice(0, idx) +
        processedText +
        existingContent.slice(idx + lastProcessed.length),
    };
  }
  const sep = existingContent.endsWith('\n') ? '' : '\n';
  return { text: existingContent + sep + processedText };
}
