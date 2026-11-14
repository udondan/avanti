// ── Serialiser ────────────────────────────────────────────────────────────────
import { parseIniDoc } from './parse';
import type {
  IniDocument,
  IniKeyValue,
  IniScalar,
  IniSection,
  IniSectionItem,
} from './types';

function stringifyScalar(v: IniScalar): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  // Quote values that start/end with whitespace, contain special chars, or end
  // with a backslash — a trailing backslash would be misread as a continuation
  // marker on the next round-trip parse.
  if (/^\s|\s$|[;#"]|\\$/.test(v))
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

function stringifyItem(item: IniSectionItem): string {
  if (item.kind === 'blank') return '';
  if (item.kind === 'comment') return item.raw;
  return stringifyKv(item);
}

function stringifySectionHeader(section: IniSection): string {
  const sub = section.subName !== undefined ? ` "${section.subName}"` : '';
  const hc = section.headerComment ? ` ${section.headerComment}` : '';
  return `[${section.name}${sub}]${hc}`;
}

export function stringifyIniDoc(doc: IniDocument): string {
  const out: string[] = [];
  for (const item of doc.items) {
    if (item.kind !== 'section') {
      out.push(stringifyItem(item));
      continue;
    }
    out.push(stringifySectionHeader(item));
    for (const child of item.items) out.push(stringifyItem(child));
  }
  return out.join('\n') + '\n';
}

export function formatIni(content: string): string {
  try {
    return stringifyIniDoc(parseIniDoc(content));
  } catch (e) {
    throw new Error(`invalid INI: ${(e as Error).message}`, { cause: e });
  }
}
