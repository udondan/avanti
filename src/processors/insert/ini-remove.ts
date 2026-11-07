/** Removes a previous INI contribution from a parsed document. */
import type { IniDocument, IniKeyValue, IniScalar, IniSection } from '../ini';
import {
  INI_ARRAY_PREFIX,
  INI_SECTION_PREFIX,
  findIniSections,
  findLastKv,
  isKvNode,
  spliceIniNode,
} from './ini-common';
import {
  deepEqual,
  isPlainObject,
  newValueOf,
  removeArrayContribution,
} from './util';
import { removeIniGlobal } from './ini-remove-global';

// Removes the given sections when they have no key/value pairs left. The last
// section is kept instead when `keepEffective` is set, so the merge refills it
// in place; it is then added to `kept`.
export function removeEmptiedSections(
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

interface SectionRemoval {
  searchOrder: IniSection[];
  effective: IniSection;
  kept: Set<object>;
  touched: Set<IniSection>;
}

interface SectionNode {
  section: IniSection;
  node: IniKeyValue;
}

function findArrayNodes(searchOrder: IniSection[], key: string): SectionNode[] {
  const matches: SectionNode[] = [];
  for (const section of searchOrder) {
    const items = section.items;
    for (let j = items.length - 1; j >= 0; j--) {
      const it = items[j];
      if (isKvNode(it, key, true)) matches.push({ section, node: it });
    }
  }
  return matches;
}

function removeSectionArray(
  ctx: SectionRemoval,
  key: string,
  oldVal: unknown[],
  newVal: unknown,
): void {
  // iniDocToJs prefixes every array key, so the prefix is always present.
  const iniKey = key.slice(INI_ARRAY_PREFIX.length);
  let remaining: unknown[] = oldVal;
  for (const { section, node } of findArrayNodes(ctx.searchOrder, iniKey)) {
    if (remaining.length === 0) break;
    const curArr = node.value as IniScalar[];
    const before = curArr.length;
    remaining = removeArrayContribution(curArr, remaining);
    if (curArr.length === before) continue;
    ctx.touched.add(section);
    // An empty node in the last section stays in place when the key is
    // still an array, so mergeIni refills it at the same position.
    // Otherwise (key removed, type changed to scalar, or an earlier
    // section the merge never writes to) the node is dropped.
    const refilled = section === ctx.effective && Array.isArray(newVal);
    if (curArr.length === 0 && !refilled) {
      spliceIniNode(section.items, node);
    }
  }
}

// The last node wins in INI, so only that one is compared.
function findLastScalarNode(
  searchOrder: IniSection[],
  key: string,
): SectionNode | undefined {
  for (const section of searchOrder) {
    const node = findLastKv(section.items, key, false);
    if (node) return { section, node };
  }
  return undefined;
}

function removeSectionScalar(
  ctx: SectionRemoval,
  key: string,
  oldVal: unknown,
  newVal: unknown,
): void {
  const match = findLastScalarNode(ctx.searchOrder, key);
  if (!match) return;
  // Skip only when the node is in the last section and newVal is the same
  // scalar type, so mergeIni updates it in place. Otherwise remove it:
  // the merge writes the new shape or value into the last section.
  const updatedInPlace = newVal !== undefined && !Array.isArray(newVal);
  if (match.section === ctx.effective && updatedInPlace) {
    if (deepEqual(match.node.value, oldVal)) ctx.kept.add(match.node);
    return;
  }
  if (deepEqual(match.node.value, oldVal)) {
    spliceIniNode(match.section.items, match.node);
    ctx.touched.add(match.section);
  }
}

// Removes the old contribution from the given sections, searched in the given
// order. Only in `effective` (the last section with that name, the one
// mergeIni merges into) may nodes stay in place for the merge to refill; those
// nodes are added to `kept`. Returns the sections that had something removed.
export function deepRemoveFromIniSections(
  searchOrder: IniSection[],
  effective: IniSection,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
  kept: Set<object>,
): Set<IniSection> {
  const ctx: SectionRemoval = {
    searchOrder,
    effective,
    kept,
    touched: new Set<IniSection>(),
  };
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal = newValueOf(newContrib, key);
    if (Array.isArray(oldVal)) removeSectionArray(ctx, key, oldVal, newVal);
    else removeSectionScalar(ctx, key, oldVal, newVal);
  }
  return ctx.touched;
}

function findSectionsForKey(doc: IniDocument, key: string): IniSection[] {
  // iniDocToJs prefixes every section key, so the prefix is always present.
  const sectionKey = key.slice(INI_SECTION_PREFIX.length);
  const subsectionMatch = /^(.+?)\s+"([^"]*)"$/.exec(sectionKey);
  return subsectionMatch
    ? findIniSections(doc, subsectionMatch[1], subsectionMatch[2])
    : findIniSections(doc, sectionKey, undefined);
}

// Removes an old contribution that is only known as the text of the fragment
// (history written before ownership tracking). Values are searched in every
// section with a matching name.
export function deepRemoveFromIniDoc(
  doc: IniDocument,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
  newKeys: ReadonlySet<string>,
  kept: Set<object>,
): void {
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal = newValueOf(newContrib, key);

    if (!isPlainObject(oldVal)) {
      removeIniGlobal(doc, key, oldVal, newVal, kept);
      continue;
    }
    const sections = findSectionsForKey(doc, key);
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
