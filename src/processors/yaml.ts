import { parseDocument, isMap, isSeq, isScalar, Pair } from 'yaml';
import { YamlMergeOptions } from '../types';

interface ResolvedOptions {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat';
  objects: 'replace' | 'merge';
}

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

function mergeMapNodes(
  base: ReturnType<typeof parseDocument>['contents'] & object,
  overlay: ReturnType<typeof parseDocument>['contents'] & object,
  opts: ResolvedOptions,
  path: string,
): void {
  if (!isMap(base) || !isMap(overlay)) return;

  for (const overlayPair of overlay.items) {
    const key = pairKey(overlayPair);
    const basePairIdx = base.items.findIndex((p) => pairKey(p) === key);

    if (basePairIdx === -1) {
      base.items.push(overlayPair);
    } else {
      const basePair = base.items[basePairIdx];
      const baseVal = basePair.value;
      const overlayVal = overlayPair.value;
      const childPath = path ? `${path}.${key}` : key;

      if (isMap(baseVal) && isMap(overlayVal) && opts.objects === 'merge') {
        mergeMapNodes(baseVal, overlayVal, opts, childPath);
      } else if (
        isSeq(baseVal) &&
        isSeq(overlayVal) &&
        opts.arrays === 'concat'
      ) {
        for (const item of overlayVal.items) {
          baseVal.items.push(item);
        }
      } else {
        if (nodesEqual(baseVal, overlayVal)) continue;
        if (opts.conflicts === 'abort') {
          throw new Error(`YAML conflict at ${childPath}`);
        }
        if (opts.conflicts === 'last_wins') {
          basePair.value = overlayVal;
        }
        // first_wins: keep basePair.value
      }
    }
  }
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
      const doc = parseDocument(p);
      if (doc.errors.length > 0) {
        throw new Error(doc.errors[0].message);
      }
      return doc;
    } catch (e) {
      throw new Error(`[source ${i}]: invalid YAML: ${(e as Error).message}`, {
        cause: e,
      });
    }
  });

  const base = docs[0];

  for (let i = 1; i < docs.length; i++) {
    const overlay = docs[i];
    const baseContents = base.contents;
    const overlayContents = overlay.contents;

    if (isMap(baseContents) && isMap(overlayContents)) {
      mergeMapNodes(baseContents, overlayContents, resolved, '');
    } else if (baseContents !== null && overlayContents !== null) {
      if (nodesEqual(baseContents, overlayContents)) continue;
      if (resolved.conflicts === 'abort') {
        throw new Error('YAML conflict at (root)');
      }
      if (resolved.conflicts === 'last_wins') {
        base.contents = overlayContents;
      }
    } else if (overlayContents !== null) {
      base.contents = overlayContents;
    }
  }

  const result = base.toString();
  return result.endsWith('\n') ? result : result + '\n';
}

export function formatYaml(content: string): string {
  try {
    const doc = parseDocument(content);
    if (doc.errors.length > 0) {
      throw new Error(doc.errors[0].message);
    }
    const result = doc.toString();
    return result.endsWith('\n') ? result : result + '\n';
  } catch (e) {
    throw new Error(`invalid YAML: ${(e as Error).message}`, { cause: e });
  }
}
