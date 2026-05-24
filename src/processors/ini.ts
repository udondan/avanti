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
  const rawLines = text.split(/\r?\n/);
  // Drop the trailing empty string that split() produces when text ends with \n
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines;
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
      const name = sectionMatch[1].trim();
      const subName = sectionMatch[2] ?? undefined;
      if (
        name.includes('\0') ||
        (subName !== undefined && subName.includes('\0'))
      ) {
        throw new Error(
          `line ${i + 1}: INI section name must not contain null bytes`,
        );
      }
      const section: IniSection = {
        kind: 'section',
        name,
        subName,
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
      if (key.includes('\0')) {
        throw new Error(`line ${i + 1}: INI key must not contain null bytes`);
      }
      const isArray = kvMatch[2] === '[]';
      const sep = trimmed
        .slice(kvMatch[1].length + (isArray ? 2 : 0))
        .match(/^(\s*=\s?)/)![1];

      // Collect value including continuation lines
      let rawValue = trimmed.slice(
        kvMatch[1].length + (isArray ? 2 : 0) + sep.length,
      );

      while (rawValue.endsWith('\\') && i + 1 < lines.length) {
        rawValue = rawValue.slice(0, -1); // strip trailing backslash
        i++;
        rawValue += lines[i].trim();
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
      };

      // Coalesce array entries with the same key[] into the same node
      if (isArray) {
        const target = currentSection ? currentSection.items : doc.items;
        let existing: IniKeyValue | undefined;
        for (let j = target.length - 1; j >= 0; j--) {
          const it = target[j];
          if (it.kind === 'kv' && it.key === key && it.isArray) {
            existing = it;
            break;
          }
        }
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

    // Bare key (no `=`): treat as empty-string value.
    // Reject lines that look like a broken section header or an empty-key
    // assignment — those are parse errors, not bare keys.
    if (trimmed !== '') {
      if (trimmed.startsWith('[')) {
        throw new Error(`line ${i + 1}: malformed section header: ${trimmed}`);
      }
      if (trimmed.startsWith('=')) {
        throw new Error(
          `line ${i + 1}: key/value line with empty key: ${trimmed}`,
        );
      }
      const { value: bareKey, inlineComment: bareComment } =
        splitValueAndComment(trimmed);
      pushItem({
        kind: 'kv',
        key: bareKey,
        isArray: false,
        value: '',
        sep: '',
        inlineComment: bareComment,
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
    return `${node.key}${comment}`;
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

  return out.join('\n') + '\n';
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

function sectionKvsEqual(a: IniSection, b: IniSection): boolean {
  // Compare semantically: the effective value of each key is the last
  // occurrence (INI last-wins). Build key→value maps and compare those,
  // so sections with the same effective keys/values but different ordering
  // or duplicate runs are treated as identical.
  const toEffective = (
    kvs: IniKeyValue[],
  ): Map<string, IniScalar | IniScalar[]> => {
    const m = new Map<string, IniScalar | IniScalar[]>();
    for (const kv of kvs) {
      m.set(`${kv.key}\0${kv.isArray ? '1' : '0'}`, kv.value);
    }
    return m;
  };
  const aKvs = a.items.filter((it): it is IniKeyValue => it.kind === 'kv');
  const bKvs = b.items.filter((it): it is IniKeyValue => it.kind === 'kv');
  const aMap = toEffective(aKvs);
  const bMap = toEffective(bKvs);
  if (aMap.size !== bMap.size) return false;
  for (const [k, aVal] of aMap) {
    if (!bMap.has(k)) return false;
    if (!valuesEqual(aVal, bMap.get(k)!)) return false;
  }
  return true;
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
  // Match by key only (ignoring isArray) so that a scalar↔array type change on
  // the same key is handled by the conflict strategy rather than silently
  // producing duplicate entries (one scalar + one array) in the output.
  let idx = -1;
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j];
    if (it.kind === 'kv' && it.key === overlay.key) {
      idx = j;
      break;
    }
  }

  if (idx === -1) {
    // New key — insert after the last existing KV; if none exist, append at end
    // so that leading comment/blank nodes are not displaced.
    let insertAt = items.length;
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].kind === 'kv') {
        insertAt = j + 1;
        break;
      }
    }
    items.splice(insertAt, 0, { ...overlay });
    return;
  }

  const baseKv = items[idx] as IniKeyValue;

  // Scalar↔array type change: treat as a conflict regardless of array strategy.
  if (baseKv.isArray !== overlay.isArray) {
    const loc = path || '(root)';
    if (opts.conflicts === 'abort') throw new Error(`INI conflict at ${loc}`);
    if (opts.conflicts === 'first_wins') return;
    // last_wins: replace value and type in-place.
    baseKv.value = overlay.value;
    baseKv.isArray = overlay.isArray;
    if ((baseKv.sep === '') !== (overlay.sep === '')) baseKv.sep = overlay.sep;
    return;
  }

  if (valuesEqual(baseKv.value, overlay.value)) return;

  if (Array.isArray(baseKv.value) && Array.isArray(overlay.value)) {
    if (opts.arrays === 'concat') {
      baseKv.value = [...baseKv.value, ...overlay.value];
      return;
    }
    if (opts.arrays === 'dedupe') {
      baseKv.value = dedupeArrayValues(baseKv.value, overlay.value);
      return;
    }
    // replace (default) falls through to conflict handling
  }

  const loc = path || '(root)';
  if (opts.conflicts === 'abort') {
    throw new Error(`INI conflict at ${loc}`);
  }
  if (opts.conflicts === 'first_wins') return;

  // last_wins: update value in-place; preserve sep when both sides are key=value,
  // but adopt the overlay sep when the shape changes (bare ↔ key=value).
  baseKv.value = overlay.value;
  if ((baseKv.sep === '') !== (overlay.sep === '')) {
    baseKv.sep = overlay.sep;
  }
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
      // Sync back: mergeKvIntoItems works on the filtered baseGlobals copy, so a
      // newly inserted key lives there but not yet in base.items — add it here.
      if (
        !base.items.some(
          (it) =>
            it.kind === 'kv' &&
            it.key === item.key &&
            it.isArray === item.isArray,
        )
      ) {
        // Insert after the last global KV, or at the section boundary when
        // there are no global KVs — never before leading comment/blank lines.
        const firstSectionIdx = base.items.findIndex(
          (it) => it.kind === 'section',
        );
        const boundary =
          firstSectionIdx === -1 ? base.items.length : firstSectionIdx;
        let insertAt = boundary;
        for (let j = boundary - 1; j >= 0; j--) {
          if (base.items[j].kind === 'kv') {
            insertAt = j + 1;
            break;
          }
        }
        base.items.splice(insertAt, 0, { ...item });
      }
      continue;
    }

    if (item.kind === 'section') {
      if (opts.objects === 'replace') {
        // Replace the entire matching section or append. Scan from end: INI
        // semantics give the last repeated section the effective value.
        let existingIdx = -1;
        for (let j = base.items.length - 1; j >= 0; j--) {
          const it = base.items[j];
          if (
            it.kind === 'section' &&
            it.name === item.name &&
            it.subName === item.subName
          ) {
            existingIdx = j;
            break;
          }
        }
        if (existingIdx === -1) {
          base.items.push({
            ...item,
            items: item.items.map((it) => ({ ...it })),
          });
        } else {
          const baseSection = base.items[existingIdx] as IniSection;
          if (!sectionKvsEqual(baseSection, item)) {
            // Sections differ: apply the same conflict policy used for scalars.
            // Mirrors TOML's behavior where objects:replace falls through to
            // conflict handling when the values are not identical.
            const sectionPath =
              item.subName !== undefined
                ? `${item.name} "${item.subName}"`
                : item.name;
            if (opts.conflicts === 'abort') {
              throw new Error(`INI conflict at ${sectionPath}`);
            }
            if (opts.conflicts !== 'first_wins') {
              // last_wins: replace the section
              base.items[existingIdx] = {
                ...item,
                items: item.items.map((it) => ({ ...it })),
              };
            }
            // first_wins: keep base — no-op
          }
          // identical sections: no-op
        }
        continue;
      }

      // objects: merge (default) — find or create the last section in base.
      // Scan from end: INI semantics give the last repeated section the
      // effective value, so that is the one we must merge into.
      let existing: IniSection | undefined;
      for (let j = base.items.length - 1; j >= 0; j--) {
        const it = base.items[j];
        if (
          it.kind === 'section' &&
          it.name === item.name &&
          it.subName === item.subName
        ) {
          existing = it;
          break;
        }
      }

      const sectionPath =
        item.subName !== undefined
          ? `${item.name} "${item.subName}"`
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
