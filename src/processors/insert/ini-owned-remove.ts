/** Removes exactly what a previous INI insert recorded as owned. */
import type { IniDocument, IniItem, IniKeyValue, IniScalar } from '../ini';
import {
  INI_ARRAY_PREFIX,
  INI_SECTION_PREFIX,
  iniScalarId,
  iniSectionKey,
  increment,
  isKvNode,
  splicePrecedingCommentBlanks,
} from './ini-common';
import type { IniOwnedKv, IniOwnership } from './ini-owned';
import { resolveOwnedTargets, type OwnedTarget } from './ini-owned-resolve';
import { deepRemoveFromIniSections, removeEmptiedSections } from './ini-remove';
import { removeIniGlobal } from './ini-remove-global';
import { findLastIndex } from '../find-last';
import { deepEqual, isPlainObject, newValueOf } from './util';

interface OwnedContrib {
  contrib: Record<string, unknown>;
  earlier: IniOwnedKv[];
}

// Converts owned values to the shape iniDocToJs produces. The parser keeps
// one node per array key, but a scalar key may repeat: only its last
// occurrence goes into the object, the earlier ones are returned separately.
function iniOwnedToContrib(kvs: IniOwnedKv[]): OwnedContrib {
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
    const j = findLastIndex(
      items,
      (it) =>
        isKvNode(it, key, false) && !kept.has(it) && deepEqual(it.value, value),
    );
    if (j === -1) continue;
    items.splice(j, 1);
    if (stripComments) splicePrecedingCommentBlanks(items, j);
  }
}

// The last node of a key is the one that counts in INI, and the normal removal
// only looks at that one. When it is not the owned value (a later occurrence
// belongs to the user), the owned value is an earlier occurrence: move it to
// `earlier` so it is removed on its own and the user's value stays. A later
// array node with the same key shadows it too: the merge updates the last
// node of a key whatever its type.
function moveShadowedIniScalars(items: IniItem[], owned: OwnedContrib): void {
  for (const key of Object.keys(owned.contrib)) {
    const value = owned.contrib[key];
    if (Array.isArray(value)) continue;
    let last: IniKeyValue | undefined;
    for (const it of items) {
      if (it.kind === 'kv' && it.key === key) last = it;
    }
    if (last && (last.isArray || !deepEqual(last.value, value))) {
      delete owned.contrib[key];
      owned.earlier.push({ key, isArray: false, value: value as IniScalar });
    }
  }
}

function countIds(
  entries: { key: string; value: unknown }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { key, value } of entries)
    increment(counts, iniScalarId(key, value));
  return counts;
}

// The file should have as many nodes with an owned key and value as the pull
// owns plus the ones the file already had. With more, a user added the same
// value again; with fewer while some were the file's own, a user removed one
// and it may have been ours. Either way it is unclear which node is ours:
// leave all of them in place.
function dropAmbiguousIniScalars(
  items: IniItem[],
  owned: OwnedContrib,
  recorded: IniOwnedKv[],
): void {
  const shared = new Map<string, number>();
  for (const kv of recorded) {
    if (kv.shared) shared.set(iniScalarId(kv.key, kv.value), kv.shared);
  }
  const nodes = countIds(
    items.filter((it): it is IniKeyValue => it.kind === 'kv' && !it.isArray),
  );
  const scalars = [
    ...owned.earlier,
    ...Object.keys(owned.contrib)
      .filter((key) => !Array.isArray(owned.contrib[key]))
      .map((key) => ({ key, value: owned.contrib[key] })),
  ];
  const ambiguousIds = new Set<string>();
  for (const [k, ownedCount] of countIds(scalars)) {
    const found = nodes.get(k) ?? 0;
    const before = shared.get(k) ?? 0;
    const expected = ownedCount + before;
    if (found > expected || (before > 0 && found < expected)) {
      ambiguousIds.add(k);
    }
  }
  const ambiguous = (key: string, value: unknown) =>
    ambiguousIds.has(iniScalarId(key, value));
  for (const { key, value } of scalars) {
    if (!ambiguous(key, value)) continue;
    if (owned.contrib[key] === value) delete owned.contrib[key];
  }
  owned.earlier = owned.earlier.filter(
    ({ key, value }) => !ambiguous(key, value),
  );
}

interface OwnedRemoval {
  doc: IniDocument;
  newContrib: Record<string, unknown> | null;
  newKeys: ReadonlySet<string>;
  kept: Set<object>;
}

function removeOwnedGlobals(ctx: OwnedRemoval, owned: IniOwnership): void {
  const { doc, kept } = ctx;
  const globals = iniOwnedToContrib(owned.globals);
  moveShadowedIniScalars(doc.items, globals);
  dropAmbiguousIniScalars(doc.items, globals, owned.globals);
  for (const key of Object.keys(globals.contrib)) {
    const newVal = newValueOf(ctx.newContrib, key);
    removeIniGlobal(doc, key, globals.contrib[key], newVal, kept);
  }
  // Do not strip preceding comment/blank nodes at the doc level.
  removeEarlierIniScalars(doc.items, globals.earlier, kept, false);
}

function removeOwnedSection(ctx: OwnedRemoval, t: OwnedTarget): void {
  const { s, target, effective } = t;
  const jsKey = INI_SECTION_PREFIX + iniSectionKey(s.name, s.subName);
  const newVal = newValueOf(ctx.newContrib, jsKey);
  const sectionOwned = iniOwnedToContrib(s.kvs);
  moveShadowedIniScalars(target.items, sectionOwned);
  dropAmbiguousIniScalars(target.items, sectionOwned, s.kvs);
  const { contrib, earlier } = sectionOwned;
  deepRemoveFromIniSections(
    [target],
    effective,
    contrib,
    isPlainObject(newVal) ? newVal : null,
    ctx.kept,
  );
  removeEarlierIniScalars(target.items, earlier, ctx.kept, true);
  if (s.created) {
    const keep = ctx.newKeys.has(jsKey);
    removeEmptiedSections(ctx.doc, [target], effective, keep, ctx.kept);
    // A created section that stays is still one this pull added.
    ctx.kept.add(target);
  }
}

// Removes exactly what the previous pull added. Values the file already had
// are left alone, and only sections the pull created are removed.
export function removeIniOwnership(
  doc: IniDocument,
  owned: IniOwnership,
  newContrib: Record<string, unknown> | null,
  newKeys: ReadonlySet<string>,
  kept: Set<object>,
): void {
  const ctx: OwnedRemoval = { doc, newContrib, newKeys, kept };
  removeOwnedGlobals(ctx, owned);
  for (const target of resolveOwnedTargets(doc, owned.sections)) {
    removeOwnedSection(ctx, target);
  }
}
