/** Removes an old INI global (doc-level) value. */
import type { IniDocument, IniKeyValue, IniScalar } from '../ini';
import { INI_ARRAY_PREFIX, findLastKv } from './ini-common';
import { deepEqual, isPlainObject, removeArrayContribution } from './util';

function removeGlobalArray(
  doc: IniDocument,
  node: IniKeyValue,
  oldVal: unknown[],
  newVal: unknown,
): void {
  const curArr = node.value as IniScalar[];
  removeArrayContribution(curArr, oldVal);
  // An emptied node stays in place when the key is still an array, so the
  // merge refills it at the same position. Otherwise drop it. Do not strip
  // preceding comment/blank nodes at the doc level.
  if (curArr.length === 0 && !Array.isArray(newVal)) {
    doc.items.splice(doc.items.indexOf(node), 1);
  }
}

// Removes an old global (doc-level) value. Global keys come before the first
// section, so they cannot repeat across sections.
export function removeIniGlobal(
  doc: IniDocument,
  key: string,
  oldVal: unknown,
  newVal: unknown,
  kept: Set<object>,
): void {
  const isArray = Array.isArray(oldVal);
  // iniDocToJs prefixes every array key, so the prefix is always present.
  const iniKey = isArray ? key.slice(INI_ARRAY_PREFIX.length) : key;
  const node = findLastKv(doc.items, iniKey, isArray);
  if (!node) return;
  if (isArray) {
    removeGlobalArray(doc, node, oldVal as unknown[], newVal);
    return;
  }
  // Skip only when newVal is the same scalar type; remove the old node
  // when type changes to array or section so the merge can re-add it.
  const sameShape = !Array.isArray(newVal) && !isPlainObject(newVal);
  if (newVal !== undefined && sameShape) {
    if (deepEqual(node.value, oldVal)) kept.add(node);
    return;
  }
  if (deepEqual(node.value, oldVal)) {
    // Do not strip preceding comment/blank nodes at the doc level.
    doc.items.splice(doc.items.indexOf(node), 1);
  }
}
