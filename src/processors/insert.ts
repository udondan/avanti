import * as fs from 'fs';
import { parse as parseJson, stringify as stringifyJson } from 'comment-json';
import { parseDocument, isMap, isSeq, isScalar, type Pair } from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { FileEntry, FileSrc } from '../types';
import { mergeJson } from './json';
import { mergeYaml } from './yaml';
import { mergeToml } from './toml';
import {
  parseIniDoc,
  stringifyIniDoc,
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
  base: ReturnType<typeof parseDocument>['contents'] & object,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null = null,
): void {
  if (!isMap(base)) return;

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
): void {
  for (let i = oldItems.length - 1; i >= 0; i--) {
    const target = oldItems[i];
    for (let j = existing.length - 1; j >= 0; j--) {
      if (deepEqual(toJs(existing[j]), target)) {
        existing.splice(j, 1);
        break;
      }
    }
  }
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

function deepRemoveFromIniSectionItems(
  items: IniSectionItems,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
): void {
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (Array.isArray(oldVal)) {
      const iniKey = key.startsWith(INI_ARRAY_PREFIX)
        ? key.slice(INI_ARRAY_PREFIX.length)
        : key;
      let node: IniKeyValue | undefined;
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j];
        if (it.kind === 'kv' && it.key === iniKey && it.isArray) {
          node = it;
          break;
        }
      }
      if (!node) continue;
      const curArr = node.value as IniScalar[];
      removeArrayContribution(curArr, oldVal);
      // Remove the array node when it becomes empty and newVal is not an array
      // (key removed or type changed to scalar).
      if (curArr.length === 0 && !Array.isArray(newVal)) {
        const idx = items.indexOf(node);
        if (idx !== -1) {
          items.splice(idx, 1);
          splicePrecedingCommentBlanks(items, idx);
        }
      }
    } else {
      let node: IniKeyValue | undefined;
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j];
        if (it.kind === 'kv' && it.key === key && !it.isArray) {
          node = it;
          break;
        }
      }
      if (!node) continue;
      // Skip only when newVal is the same scalar type; if it changed to an
      // array, remove the old scalar node so mergeIni can insert the new shape.
      if (newVal !== undefined && !Array.isArray(newVal)) continue;
      if (deepEqual(node.value, oldVal)) {
        const idx = items.indexOf(node);
        if (idx !== -1) {
          items.splice(idx, 1);
          splicePrecedingCommentBlanks(items, idx);
        }
      }
    }
  }
}

function deepRemoveFromIniDoc(
  doc: IniDocument,
  oldContrib: Record<string, unknown>,
  newContrib: Record<string, unknown> | null,
): void {
  for (const key of Object.keys(oldContrib)) {
    const oldVal = oldContrib[key];
    const newVal =
      newContrib != null && Object.hasOwn(newContrib, key)
        ? newContrib[key]
        : undefined;

    if (isPlainObject(oldVal)) {
      const sectionName = key.startsWith(INI_SECTION_PREFIX)
        ? key.slice(INI_SECTION_PREFIX.length)
        : key;
      const subsectionMatch = /^(.+?)\s+"([^"]*)"$/.exec(sectionName);
      let section: IniSection | undefined;
      for (let j = doc.items.length - 1; j >= 0; j--) {
        const it = doc.items[j];
        if (it.kind !== 'section') continue;
        if (subsectionMatch) {
          if (
            it.name === subsectionMatch[1] &&
            it.subName === subsectionMatch[2]
          ) {
            section = it;
            break;
          }
        } else if (it.name === sectionName && it.subName === undefined) {
          section = it;
          break;
        }
      }
      if (!section) continue;
      const nestedNew = isPlainObject(newVal) ? newVal : null;
      deepRemoveFromIniSectionItems(section.items, oldVal, nestedNew);
      // Remove the section when it's empty and newVal is not also a section
      // (key removed or type changed to scalar/array).
      if (
        section.items.filter((it) => it.kind === 'kv').length === 0 &&
        !isPlainObject(newVal)
      ) {
        const idx = doc.items.indexOf(section);
        if (idx !== -1) {
          doc.items.splice(idx, 1);
          splicePrecedingCommentBlanks(doc.items, idx);
        }
      }
    } else if (Array.isArray(oldVal)) {
      const iniKey = key.startsWith(INI_ARRAY_PREFIX)
        ? key.slice(INI_ARRAY_PREFIX.length)
        : key;
      let node: IniKeyValue | undefined;
      for (let j = doc.items.length - 1; j >= 0; j--) {
        const it = doc.items[j];
        if (it.kind === 'kv' && it.key === iniKey && it.isArray) {
          node = it;
          break;
        }
      }
      if (!node) continue;
      const curArr = node.value as IniScalar[];
      removeArrayContribution(curArr, oldVal);
      // Remove the array node when it becomes empty and newVal is not an array
      // (key removed or type changed to scalar/section).
      if (curArr.length === 0 && !Array.isArray(newVal)) {
        const idx = doc.items.indexOf(node);
        if (idx !== -1) {
          doc.items.splice(idx, 1);
          splicePrecedingCommentBlanks(doc.items, idx);
        }
      }
    } else {
      let node: IniKeyValue | undefined;
      for (let j = doc.items.length - 1; j >= 0; j--) {
        const it = doc.items[j];
        if (it.kind === 'kv' && it.key === key && !it.isArray) {
          node = it;
          break;
        }
      }
      if (!node) continue;
      // Skip only when newVal is the same scalar type; remove the old node
      // when type changes to array or section so the merge can re-add it.
      if (
        newVal !== undefined &&
        !Array.isArray(newVal) &&
        !isPlainObject(newVal)
      )
        continue;
      if (deepEqual(node.value, oldVal)) {
        const idx = doc.items.indexOf(node);
        if (idx !== -1) {
          doc.items.splice(idx, 1);
          splicePrecedingCommentBlanks(doc.items, idx);
        }
      }
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
        `insert mode: existing file is not valid JSON/JSONC: ${err instanceof Error ? err.message : String(err)}`,
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
        `insert mode: existing file is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
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
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  let cleanedIni: string;
  if (lastProcessed !== null) {
    let existingDoc: IniDocument;
    try {
      existingDoc = parseIniDoc(existingContent);
    } catch (err) {
      throw new Error(
        `insert mode: existing file is not valid INI: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    try {
      const oldDoc = parseIniDoc(lastProcessed);
      const oldContrib = iniDocToJs(oldDoc);
      // Order-preservation only works under last_wins; with first_wins the
      // stale key would persist, and with abort mergeIni would throw on
      // the un-removed key.
      const rawConflicts = opts['conflicts'];
      const effectiveConflicts =
        rawConflicts === 'abort' || rawConflicts === 'first_wins'
          ? rawConflicts
          : 'last_wins';
      let newContrib: Record<string, unknown> | null = null;
      if (effectiveConflicts === 'last_wins') {
        try {
          const p = iniDocToJs(parseIniDoc(processedText));
          if (isPlainObject(p)) newContrib = p;
        } catch {
          // unparseable processedText → null (old behaviour)
        }
      }
      deepRemoveFromIniDoc(existingDoc, oldContrib, newContrib);
    } catch {
      // Corrupted history fragment — skip key removal, fall through to merge
    }
    cleanedIni = stringifyIniDoc(existingDoc);
  } else {
    cleanedIni = existingContent;
  }
  return mergeIni([cleanedIni, processedText], opts);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function applyInsertMode(
  entry: FileEntry,
  processedText: string,
  lastProcessed: string | null,
  targetPath: string,
): string {
  if (!fs.existsSync(targetPath)) {
    return processedText;
  }

  const existingContent = fs.readFileSync(targetPath, 'utf8');
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

  if (jsonOpts !== null) {
    return applyJsonInsert(
      existingContent,
      processedText,
      lastProcessed,
      jsonOpts as Record<string, unknown>,
    );
  }
  if (yamlOpts !== null) {
    return applyYamlInsert(
      existingContent,
      processedText,
      lastProcessed,
      yamlOpts as Record<string, unknown>,
    );
  }
  if (tomlOpts !== null) {
    return applyTomlInsert(
      existingContent,
      processedText,
      lastProcessed,
      tomlOpts as Record<string, unknown>,
    );
  }
  if (iniOpts !== null) {
    return applyIniInsert(
      existingContent,
      processedText,
      lastProcessed,
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
    return (
      existingContent.slice(0, idx) +
      processedText +
      existingContent.slice(idx + lastProcessed.length)
    );
  }
  const sep = existingContent.endsWith('\n') ? '' : '\n';
  return existingContent + sep + processedText;
}
