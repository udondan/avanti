import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { YamlMergeOptions } from '../types';

interface ResolvedOptions {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat' | 'dedupe';
  objects: 'replace' | 'merge';
}

type YamlDocument = ReturnType<typeof parseDocument>;

function pairKey(pair: Pair): string {
  if (isScalar(pair.key)) return String(pair.key.value);
  return String(pair.key);
}

function nodeToJs(node: unknown): unknown {
  if (
    node !== null &&
    typeof node === 'object' &&
    typeof (node as Record<string, unknown>)['toJSON'] === 'function'
  ) {
    return (node as { toJSON(): unknown }).toJSON();
  }
  return node;
}

function nodesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(nodeToJs(a)) === JSON.stringify(nodeToJs(b));
}

function dedupeSeqItems(existing: unknown[], incoming: unknown[]): unknown[] {
  const result = [...existing];
  for (const item of incoming) {
    if (!result.some((e) => nodesEqual(e, item))) {
      result.push(item);
    }
  }
  return result;
}

// Whether the overlay value replaces the base one; throws under abort.
function overlayReplaces(
  baseVal: unknown,
  overlayVal: unknown,
  conflicts: ResolvedOptions['conflicts'],
  path: string,
): boolean {
  if (nodesEqual(baseVal, overlayVal)) return false;
  if (conflicts === 'abort') {
    throw new Error(`YAML conflict at ${path}`);
  }
  // first_wins: keep the base value
  return conflicts === 'last_wins';
}

function mergeSeqNodes(
  baseVal: YAMLSeq,
  overlayVal: YAMLSeq,
  arrays: ResolvedOptions['arrays'],
): boolean {
  if (arrays === 'concat') {
    for (const item of overlayVal.items) {
      baseVal.items.push(item);
    }
    return true;
  }
  if (arrays === 'dedupe') {
    baseVal.items = dedupeSeqItems(baseVal.items, overlayVal.items);
    return true;
  }
  return false;
}

// Merges two maps or two sequences per the options; false when the values
// are handled as a conflict instead.
function mergeContainers(
  baseVal: unknown,
  overlayVal: unknown,
  opts: ResolvedOptions,
  path: string,
): boolean {
  if (isMap(baseVal) && isMap(overlayVal) && opts.objects === 'merge') {
    mergeMapNodes(baseVal, overlayVal, opts, path);
    return true;
  }
  return (
    isSeq(baseVal) &&
    isSeq(overlayVal) &&
    mergeSeqNodes(baseVal, overlayVal, opts.arrays)
  );
}

function mergeMapNodes(
  base: YAMLMap,
  overlay: YAMLMap,
  opts: ResolvedOptions,
  path: string,
): void {
  for (const overlayPair of overlay.items) {
    const key = pairKey(overlayPair);
    const basePair = base.items.find((p) => pairKey(p) === key);
    if (!basePair) {
      base.items.push(overlayPair);
      continue;
    }
    const childPath = path ? `${path}.${key}` : key;
    const overlayVal = overlayPair.value;
    if (mergeContainers(basePair.value, overlayVal, opts, childPath)) continue;
    if (
      overlayReplaces(basePair.value, overlayVal, opts.conflicts, childPath)
    ) {
      basePair.value = overlayVal;
    }
  }
}

function mergeDocuments(
  base: YamlDocument,
  overlay: YamlDocument,
  opts: ResolvedOptions,
): void {
  const baseContents = base.contents;
  const overlayContents = overlay.contents;
  if (isMap(baseContents) && isMap(overlayContents)) {
    mergeMapNodes(baseContents, overlayContents, opts, '');
  } else if (
    overlayContents !== null &&
    (baseContents === null ||
      overlayReplaces(baseContents, overlayContents, opts.conflicts, '(root)'))
  ) {
    base.contents = overlayContents;
  }
}

function parseStrict(text: string): YamlDocument {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0].message);
  }
  return doc;
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

export function mergeYaml(
  parts: string[],
  opts: YamlMergeOptions = {},
): string {
  const resolved: ResolvedOptions = {
    conflicts: opts.conflicts ?? 'last_wins',
    arrays: opts.arrays ?? 'replace',
    objects: opts.objects ?? 'merge',
  };

  if (parts.length === 0) return '';

  const docs = parts.map((p, i) => {
    try {
      return parseStrict(p);
    } catch (e) {
      throw new Error(`[source ${i}]: invalid YAML: ${(e as Error).message}`, {
        cause: e,
      });
    }
  });

  const base = docs[0];
  for (let i = 1; i < docs.length; i++) {
    mergeDocuments(base, docs[i], resolved);
  }

  return withTrailingNewline(base.toString());
}

export function formatYaml(content: string): string {
  try {
    return withTrailingNewline(parseStrict(content).toString());
  } catch (e) {
    throw new Error(`invalid YAML: ${(e as Error).message}`, { cause: e });
  }
}
