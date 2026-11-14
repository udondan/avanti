import * as fs from 'fs';
import { parseDocument, isMap, isScalar, isSeq, Document } from 'yaml';
import { atomicWrite } from './writer';
import {
  ItemNode,
  isPresent,
  kindLabel,
  NodeGet,
  NodeLike,
  SRC_KINDS,
} from './config/writeback-labels';

function filterSuffix(n: ItemNode): string {
  const rawFilter = n.get('filter', true);
  if (!isSeq(rawFilter) || rawFilter.items.length === 0) return '';
  const filterArr = rawFilter.items
    .map((item) => (isScalar(item) ? String(item.value) : null))
    .filter((f): f is string => f !== null && f.length > 0);
  return filterArr.length > 0 ? `\x00filter:${JSON.stringify(filterArr)}` : '';
}

interface SrcMatch {
  label: string;
  shaPath: (string | number)[];
}

function matchSrcItem(
  n: ItemNode,
  srcBase: (string | number)[],
): SrcMatch | null {
  for (const kind of SRC_KINDS) {
    const value = n.get(kind.key);
    if (!isPresent(kind, value)) continue;
    const label = kindLabel(kind, value);
    if (!label) return null;
    return {
      label: kind.supportsFilter ? label + filterSuffix(n) : label,
      shaPath: kind.nested
        ? [...srcBase, kind.key, 'sha']
        : [...srcBase, 'sha'],
    };
  }
  return null;
}

/**
 * Applies the matching update for one src item; returns true if the
 * document was modified.
 */
function processSrcItem(
  doc: Document,
  updates: Map<string, string>,
  item: unknown,
  srcBase: (string | number)[],
): boolean {
  const n = item as { get?: NodeGet };
  if (!n.get) return false;
  const match = matchSrcItem({ get: n.get.bind(n) }, srcBase);
  if (!match || !updates.has(match.label)) return false;
  const newSha = updates.get(match.label);
  if ((doc.getIn(match.shaPath) as string | undefined) === newSha) return false;
  doc.setIn(match.shaPath, newSha);
  return true;
}

function processFileEntry(
  doc: Document,
  updates: Map<string, string>,
  pair: { key: unknown; value: unknown },
): boolean {
  const targetKey = isScalar(pair.key) ? String(pair.key.value) : null;
  if (!targetKey) return false;

  const entryNode = pair.value as NodeLike;
  if (!entryNode?.get) return false;

  const srcNode = entryNode.get('src', true);
  if (!srcNode) return false;

  // A src sequence includes the numeric index in the sha path; a single src
  // map omits it so the path matches.
  if (!isSeq(srcNode)) {
    return processSrcItem(doc, updates, srcNode, ['files', targetKey, 'src']);
  }
  let changed = false;
  srcNode.items.forEach((item, idx) => {
    const base = ['files', targetKey, 'src', idx];
    if (processSrcItem(doc, updates, item, base)) changed = true;
  });
  return changed;
}

/**
 * Applies updated SHA values into a parsed YAML config string in-place,
 * preserving comments. Returns the new content, or null if no updates matched.
 */
export function applyUpdatedShas(
  raw: string,
  updates: Map<string, string>, // sourceLabel → new sha
): string | null {
  if (updates.size === 0) return null;
  const doc = parseDocument(raw);

  const filesNode = doc.get('files', true);
  if (!isMap(filesNode)) return null;

  let changed = false;
  for (const pair of filesNode.items) {
    if (processFileEntry(doc, updates, pair)) changed = true;
  }

  return changed ? doc.toString() : null;
}

/**
 * Writes updated SHA values into the config YAML file in-place, preserving comments.
 * Returns true if the file was actually modified, false if no labels matched or all
 * values were already up to date.
 */
export function writeUpdatedShas(
  configPath: string,
  updates: Map<string, string>, // sourceLabel → new sha
): boolean {
  if (updates.size === 0) return false;
  const raw = fs.readFileSync(configPath, 'utf8');
  const newContent = applyUpdatedShas(raw, updates);
  if (newContent !== null) {
    atomicWrite([
      { targetPath: configPath, content: Buffer.from(newContent, 'utf8') },
    ]);
    return true;
  }
  return false;
}
