import { IniMergeOptions } from '../types';

// ── AST types ─────────────────────────────────────────────────────────────────

export interface IniComment {
  kind: 'comment';
  raw: string; // the full original line (including newline stripped)
}

export interface IniBlank {
  kind: 'blank';
}

export interface IniKeyValue {
  kind: 'kv';
  key: string; // normalised key (trimmed; `[]` suffix stripped for arrays)
  isArray: boolean; // true when key ended with `[]`
  value: IniScalar | IniScalar[]; // scalar or array (for isArray keys)
  sep: string; // separator as written: ' = ', '=', ' =', '= ', etc.
  inlineComment?: string; // text after trailing `;` or `#`, including delimiter
  continuationLines: string[]; // raw continuation lines (backslash-joined)
}

export interface IniSection {
  kind: 'section';
  name: string; // e.g. "remote"
  subName?: string; // e.g. "origin" from [remote "origin"]
  headerComment?: string; // text after `]` on the header line
  items: (IniComment | IniBlank | IniKeyValue)[];
}

export type IniItem = IniComment | IniBlank | IniKeyValue | IniSection;
export type IniScalar = string | number | boolean;

export interface IniDocument {
  items: IniItem[];
}

// ── Parser ────────────────────────────────────────────────────────────────────

const COMMENT_LINE_RE = /^([;#].*)$/;
const SECTION_RE = /^\[([^\]"]+?)(?:\s+"([^"]*)")?\]\s*((?:[;#].*)?)$/;
const KV_RE = /^([^=\s][^=]*?)(\[\])?\s*(=)\s?/;

function unquoteValue(raw: string): IniScalar {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  const n = Number(trimmed);
  if (trimmed !== '' && !isNaN(n)) return n;
  return trimmed;
}

function splitValueAndComment(raw: string): {
  value: string;
  inlineComment?: string;
} {
  // Walk the string character by character respecting quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '\\' && inDouble) {
      i++; // skip escaped character — don't toggle quote state on \"
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === ';' || ch === '#')) {
      return {
        value: raw.slice(0, i).trimEnd(),
        inlineComment: raw.slice(i),
      };
    }
  }
  return { value: raw.trimEnd() };
}

export function parseIniDoc(text: string): IniDocument {
  const lines = text.split(/\r?\n/);
  const doc: IniDocument = { items: [] };
  let currentSection: IniSection | null = null;

  const pushItem = (item: IniItem) => {
    if (currentSection && item.kind !== 'section') {
      (currentSection.items as IniItem[]).push(item);
    } else {
      doc.items.push(item);
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (trimmed === '') {
      pushItem({ kind: 'blank' });
      i++;
      continue;
    }

    // Comment-only line
    if (COMMENT_LINE_RE.test(trimmed)) {
      pushItem({ kind: 'comment', raw: line });
      i++;
      continue;
    }

    // Section header
    const sectionMatch = trimmed.match(SECTION_RE);
    if (sectionMatch) {
      const section: IniSection = {
        kind: 'section',
        name: sectionMatch[1].trim(),
        subName: sectionMatch[2] ?? undefined,
        headerComment: sectionMatch[3] || undefined,
        items: [],
      };
      doc.items.push(section);
      currentSection = section;
      i++;
      continue;
    }

    // Key-value (with possible backslash continuation)
    const kvMatch = trimmed.match(KV_RE);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const isArray = kvMatch[2] === '[]';
      const sep = trimmed
        .slice(kvMatch[1].length + (isArray ? 2 : 0))
        .match(/^(\s*=\s?)/)![1];

      // Collect value including continuation lines
      let rawValue = trimmed.slice(
        kvMatch[1].length + (isArray ? 2 : 0) + sep.length,
      );
      const continuationLines: string[] = [];

      while (rawValue.endsWith('\\') && i + 1 < lines.length) {
        rawValue = rawValue.slice(0, -1); // strip trailing backslash
        i++;
        const nextRaw = lines[i];
        continuationLines.push(nextRaw);
        rawValue += nextRaw.trim();
      }

      const { value: valueStr, inlineComment } = splitValueAndComment(rawValue);
      const parsed = unquoteValue(valueStr);

      const node: IniKeyValue = {
        kind: 'kv',
        key,
        isArray,
        value: isArray ? [parsed] : parsed,
        sep,
        inlineComment,
        continuationLines,
      };

      // Coalesce array entries with the same key[] into the same node
      if (isArray) {
        const target = currentSection ? currentSection.items : doc.items;
        const existing = [...target]
          .reverse()
          .find(
            (it): it is IniKeyValue =>
              it.kind === 'kv' && it.key === key && it.isArray,
          );
        if (existing) {
          (existing.value as IniScalar[]).push(parsed);
          i++;
          continue;
        }
      }

      pushItem(node);
      i++;
      continue;
    }

    // Bare key (no `=`): treat as empty-string value
    if (trimmed !== '') {
      pushItem({
        kind: 'kv',
        key: trimmed,
        isArray: false,
        value: '',
        sep: '',
        inlineComment: undefined,
        continuationLines: [],
      });
    }
    i++;
  }

  return doc;
}

// ── Serialiser ────────────────────────────────────────────────────────────────

function stringifyScalar(v: IniScalar): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  // Quote values that start/end with whitespace or contain special chars.
  if (/^[\s]|[\s]$|[;#"]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

function stringifyKv(node: IniKeyValue): string {
  const keySuffix = node.isArray ? '[]' : '';
  const comment = node.inlineComment ? ` ${node.inlineComment}` : '';
  if (node.isArray) {
    const vals = node.value as IniScalar[];
    return vals
      .map(
        (v, i) =>
          `${node.key}${keySuffix}${node.sep}${stringifyScalar(v)}${i === 0 ? comment : ''}`,
      )
      .join('\n');
  }
  if (node.sep === '') {
    return node.key;
  }
  return `${node.key}${node.sep}${stringifyScalar(node.value as IniScalar)}${comment}`;
}

export function stringifyIniDoc(doc: IniDocument): string {
  const out: string[] = [];

  for (const item of doc.items) {
    if (item.kind === 'blank') {
      out.push('');
    } else if (item.kind === 'comment') {
      out.push(item.raw);
    } else if (item.kind === 'kv') {
      out.push(stringifyKv(item));
    } else {
      // section
      const sub = item.subName !== undefined ? ` "${item.subName}"` : '';
      const hc = item.headerComment ? ` ${item.headerComment}` : '';
      out.push(`[${item.name}${sub}]${hc}`);
      for (const child of item.items) {
        if (child.kind === 'blank') {
          out.push('');
        } else if (child.kind === 'comment') {
          out.push(child.raw);
        } else {
          out.push(stringifyKv(child));
        }
      }
    }
  }

  const result = out.join('\n');
  return result.endsWith('\n') ? result : result + '\n';
}

// ── Merge helpers ─────────────────────────────────────────────────────────────

type ResolvedOptions = {
  conflicts: 'abort' | 'first_wins' | 'last_wins';
  arrays: 'replace' | 'concat' | 'dedupe';
  objects: 'replace' | 'merge';
};

function scalarsEqual(a: IniScalar, b: IniScalar): boolean {
  return a === b;
}

function arraysEqual(a: IniScalar[], b: IniScalar[]): boolean {
  return a.length === b.length && a.every((v, i) => scalarsEqual(v, b[i]));
}

function valuesEqual(
  a: IniScalar | IniScalar[],
  b: IniScalar | IniScalar[],
): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  if (!Array.isArray(a) && !Array.isArray(b)) return scalarsEqual(a, b);
  return false;
}

function dedupeArrayValues(
  base: IniScalar[],
  overlay: IniScalar[],
): IniScalar[] {
  const result = [...base];
  for (const item of overlay) {
    if (!result.some((e) => scalarsEqual(e, item))) result.push(item);
  }
  return result;
}

function mergeKvIntoItems(
  items: (IniComment | IniBlank | IniKeyValue)[],
  overlay: IniKeyValue,
  opts: ResolvedOptions,
  path: string,
): void {
  const idx = items.findIndex(
    (it): it is IniKeyValue =>
      it.kind === 'kv' &&
      it.key === overlay.key &&
      it.isArray === overlay.isArray,
  );

  if (idx === -1) {
    items.push({ ...overlay });
    return;
  }

  const base = items[idx] as IniKeyValue;

  if (valuesEqual(base.value, overlay.value)) return;

  if (Array.isArray(base.value) && Array.isArray(overlay.value)) {
    if (opts.arrays === 'concat') {
      (items[idx] as IniKeyValue).value = [...base.value, ...overlay.value];
      return;
    }
    if (opts.arrays === 'dedupe') {
      (items[idx] as IniKeyValue).value = dedupeArrayValues(
        base.value,
        overlay.value,
      );
      return;
    }
    // replace (default) falls through to conflict handling
  }

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`INI conflict at ${loc}`);
  }
  if (opts.conflicts === 'first_wins') return;

  // last_wins: update value and sep in-place, preserve inline comment and position
  const baseKv = items[idx] as IniKeyValue;
  baseKv.value = overlay.value;
  baseKv.sep = overlay.sep;
}

function mergeSectionItems(
  base: (IniComment | IniBlank | IniKeyValue)[],
  overlay: (IniComment | IniBlank | IniKeyValue)[],
  opts: ResolvedOptions,
  sectionPath: string,
): void {
  for (const item of overlay) {
    if (item.kind !== 'kv') continue;
    const keyPath = sectionPath ? `${sectionPath}.${item.key}` : item.key;
    mergeKvIntoItems(base, item, opts, keyPath);
  }
}

function mergeDocuments(
  base: IniDocument,
  overlay: IniDocument,
  opts: ResolvedOptions,
): void {
  for (const item of overlay.items) {
    if (item.kind === 'kv') {
      // Global key — find in base globals (items before any section)
      const baseGlobals = base.items.filter(
        (it): it is IniComment | IniBlank | IniKeyValue =>
          it.kind !== 'section',
      );
      mergeKvIntoItems(baseGlobals, item, opts, item.key);
      // Sync back: if the key was new, it was pushed to baseGlobals but not to base.items
      if (
        !base.items.some(
          (it) =>
            it.kind === 'kv' &&
            it.key === item.key &&
            it.isArray === item.isArray,
        )
      ) {
        // Insert before the first section
        const firstSectionIdx = base.items.findIndex(
          (it) => it.kind === 'section',
        );
        if (firstSectionIdx === -1) {
          base.items.push({ ...item });
        } else {
          base.items.splice(firstSectionIdx, 0, { ...item });
        }
      }
      continue;
    }

    if (item.kind === 'section') {
      if (opts.objects === 'replace') {
        // Replace the entire matching section or append
        const existingIdx = base.items.findIndex(
          (it): it is IniSection =>
            it.kind === 'section' &&
            it.name === item.name &&
            (it.subName ?? '') === (item.subName ?? ''),
        );
        if (existingIdx === -1) {
          base.items.push({
            ...item,
            items: item.items.map((it) => ({ ...it })),
          });
        } else {
          base.items[existingIdx] = {
            ...item,
            items: item.items.map((it) => ({ ...it })),
          };
        }
        continue;
      }

      // objects: merge (default) — find or create the section in base
      const existing = base.items.find(
        (it): it is IniSection =>
          it.kind === 'section' &&
          it.name === item.name &&
          (it.subName ?? '') === (item.subName ?? ''),
      );

      const sectionPath =
        item.subName !== undefined
          ? `${item.name}."${item.subName}"`
          : item.name;

      if (!existing) {
        base.items.push({
          ...item,
          headerComment: undefined,
          items: item.items
            .filter((it) => it.kind === 'kv')
            .map((it) => ({ ...it })),
        });
      } else {
        mergeSectionItems(existing.items, item.items, opts, sectionPath);
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function mergeIni(parts: string[], opts: IniMergeOptions = {}): string {
  const resolved: ResolvedOptions = {
    conflicts: opts.conflicts ?? 'last_wins',
    arrays: opts.arrays ?? 'replace',
    objects: opts.objects ?? 'merge',
  };

  if (parts.length === 0) return '';

  const parsed = parts.map((p, i) => {
    try {
      return parseIniDoc(p);
    } catch (e) {
      throw new Error(`[source ${i}]: invalid INI: ${(e as Error).message}`, {
        cause: e,
      });
    }
  });

  const base = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    mergeDocuments(base, parsed[i], resolved);
  }

  return stringifyIniDoc(base);
}

export function formatIni(content: string): string {
  try {
    return stringifyIniDoc(parseIniDoc(content));
  } catch (e) {
    throw new Error(`invalid INI: ${(e as Error).message}`, { cause: e });
  }
}
