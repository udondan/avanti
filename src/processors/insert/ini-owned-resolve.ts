/** Finds the sections that owned INI entries refer to. */
import type { IniDocument, IniKeyValue, IniScalar, IniSection } from '../ini';
import { findIniSections, increment, isKvNode } from './ini-common';
import type { IniOwnedKv, IniOwnedSection } from './ini-owned';
import { deepEqual, removeArrayContribution } from './util';

// True when the section still holds every owned value. Each owned scalar
// needs its own node and each owned array item its own item, so repeated
// values are not matched twice by the same node or item.
function iniSectionHolds(section: IniSection, kvs: IniOwnedKv[]): boolean {
  const used = new Set<IniKeyValue>();
  const rest = new Map<IniKeyValue, IniScalar[]>();
  const holdsScalar = (it: IniKeyValue, kv: IniOwnedKv): boolean => {
    if (used.has(it) || !deepEqual(it.value, kv.value)) return false;
    used.add(it);
    return true;
  };
  const holdsArray = (it: IniKeyValue, kv: IniOwnedKv): boolean => {
    const items = [...(rest.get(it) ?? (it.value as IniScalar[]))];
    if (removeArrayContribution(items, kv.value as IniScalar[]).length > 0)
      return false;
    rest.set(it, items);
    return true;
  };
  return kvs.every((kv) =>
    section.items.some((it) => {
      if (!isKvNode(it, kv.key, kv.isArray)) return false;
      return kv.isArray ? holdsArray(it, kv) : holdsScalar(it, kv);
    }),
  );
}

function hasAllKeys(section: IniSection, keys: string[]): boolean {
  return keys.every((key) =>
    section.items.some((it) => it.kind === 'kv' && it.key === key),
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
      iniSectionHolds(section, s.kvs) && hasAllKeys(section, s.others),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface OwnedTarget {
  s: IniOwnedSection;
  target: IniSection;
  effective: IniSection;
}

// Find every target before changing anything: removing a section shifts
// the positions of the ones after it.
export function resolveOwnedTargets(
  doc: IniDocument,
  sections: IniOwnedSection[],
): OwnedTarget[] {
  const resolved = sections.flatMap((s) => {
    const group = findIniSections(doc, s.name, s.subName);
    const target = resolveOwnedIniSection(group, s);
    return target ? [{ s, target, effective: group[group.length - 1] }] : [];
  });
  // When several owned entries match the same section (the user merged or
  // removed sections), it is unclear which values are ours: skip them all.
  const claims = new Map<IniSection, number>();
  for (const { target } of resolved) increment(claims, target);
  return resolved.filter(({ target }) => claims.get(target) === 1);
}
