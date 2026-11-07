/** Insert mode for YAML targets. */
import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { mergeYaml } from '../yaml';
import { deepRemove, type MapAdapter } from './deep-remove';
import { isPlainObject, parseNewContrib } from './util';

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

const yamlAdapter: MapAdapter<YAMLMap> = {
  lookup: (map, key) => {
    const pair = map.items.find((p) => yamlPairKey(p) === key);
    return pair ? { value: pair.value } : undefined;
  },
  remove: (map, key) => {
    map.items.splice(
      map.items.findIndex((p) => yamlPairKey(p) === key),
      1,
    );
  },
  isMap: (value): value is YAMLMap => isMap(value),
  isSeq: (value) => isSeq(value),
  seqItems: (value) => (value as YAMLSeq).items,
  size: (map) => map.items.length,
  toJs: yamlNodeToJs,
};

function parseYamlObject(text: string): unknown {
  const doc = parseDocument(text);
  return doc.errors.length === 0 ? (doc.toJSON() as unknown) : undefined;
}

function removeYamlContribution(
  existingContent: string,
  processedText: string,
  lastProcessed: string,
  opts: Record<string, unknown>,
): string {
  const doc = parseDocument(existingContent);
  if (doc.errors.length > 0) {
    throw new Error(
      `insert mode: existing file is not valid YAML: ${doc.errors[0].message}`,
      { cause: doc.errors[0] },
    );
  }
  if (isMap(doc.contents)) {
    const lpDoc = parseDocument(lastProcessed);
    const oldContrib =
      lpDoc.errors.length === 0 ? (lpDoc.toJSON() as unknown) : null;
    if (isPlainObject(oldContrib)) {
      const newContrib = parseNewContrib(processedText, opts, parseYamlObject);
      deepRemove(yamlAdapter, doc.contents, oldContrib, newContrib);
    }
  }
  return doc.toString();
}

export function applyYamlInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  const cleanedYaml =
    lastProcessed === null
      ? existingContent
      : removeYamlContribution(
          existingContent,
          processedText,
          lastProcessed,
          opts,
        );
  return mergeYaml([cleanedYaml, processedText], opts);
}
