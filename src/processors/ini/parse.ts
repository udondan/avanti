// ── Parser ────────────────────────────────────────────────────────────────────
import { findLastIndex } from '../find-last';
import type {
  IniDocument,
  IniItem,
  IniKeyValue,
  IniScalar,
  IniSection,
  IniSectionItem,
} from './types';

const COMMENT_LINE_RE = /^([;#].*)$/;
const SECTION_RE = /^\[([^\]"]+?)(?:\s+"([^"]*)")?\]\s*((?:[;#].*)?)$/;
const KV_RE = /^([^=\s][^=]*?)(\[\])?(\s*=\s*)/;

function isWrappedIn(text: string, quote: string): boolean {
  return text.startsWith(quote) && text.endsWith(quote);
}

function parseBareScalar(trimmed: string): IniScalar {
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  const n = Number(trimmed);
  // Non-finite numbers (Infinity, 1e309) stay strings: they would be written
  // back differently and cannot be stored as JSON.
  return trimmed !== '' && Number.isFinite(n) ? n : trimmed;
}

function unquoteValue(raw: string): IniScalar {
  const trimmed = raw.trim();
  if (isWrappedIn(trimmed, '"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (isWrappedIn(trimmed, "'")) return trimmed.slice(1, -1);
  return parseBareScalar(trimmed);
}

function splitValueAndComment(raw: string): {
  value: string;
  inlineComment?: string;
} {
  // Walk the string character by character respecting quotes.
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false; // skip escaped character — don't toggle quote state on \"
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '\\' && inDouble) {
      escaped = true;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && (ch === ';' || ch === '#')) {
      return {
        value: raw.slice(0, i).trimEnd(),
        inlineComment: raw.slice(i),
      };
    }
  }
  return { value: raw.trimEnd() };
}

interface ParseState {
  lines: string[];
  /** Index of the line being parsed. */
  i: number;
  doc: IniDocument;
  section: IniSection | null;
}

function pushItem(st: ParseState, item: IniSectionItem): void {
  if (st.section) st.section.items.push(item);
  else st.doc.items.push(item);
}

function parseSectionLine(st: ParseState, trimmed: string): boolean {
  const sectionMatch = SECTION_RE.exec(trimmed);
  if (!sectionMatch) return false;
  const name = sectionMatch[1].trim();
  const subName: string | undefined = sectionMatch[2];
  if (name.includes('\0') || subName?.includes('\0')) {
    throw new Error(
      `line ${st.i + 1}: INI section name must not contain null bytes`,
    );
  }
  const section: IniSection = {
    kind: 'section',
    name,
    subName,
    headerComment: sectionMatch[3] || undefined,
    items: [],
  };
  st.doc.items.push(section);
  st.section = section;
  return true;
}

// Joins backslash continuation lines onto the value.
function readContinuation(st: ParseState, first: string): string {
  let rawValue = first;
  while (rawValue.endsWith('\\') && st.i + 1 < st.lines.length) {
    rawValue = rawValue.slice(0, -1); // strip trailing backslash
    st.i++;
    rawValue += st.lines[st.i].trim();
  }
  return rawValue;
}

// Coalesces array entries with the same key[] into the same node.
function appendToArray(
  st: ParseState,
  key: string,
  parsed: IniScalar,
): boolean {
  const target: readonly IniItem[] = st.section
    ? st.section.items
    : st.doc.items;
  const j = findLastIndex(
    target,
    (it) => it.kind === 'kv' && it.key === key && it.isArray,
  );
  if (j === -1) return false;
  ((target[j] as IniKeyValue).value as IniScalar[]).push(parsed);
  return true;
}

function parseKvLine(st: ParseState, trimmed: string): boolean {
  const kvMatch = KV_RE.exec(trimmed);
  if (!kvMatch) return false;
  const key = kvMatch[1].trim();
  if (key.includes('\0')) {
    throw new Error(`line ${st.i + 1}: INI key must not contain null bytes`);
  }
  const isArray = kvMatch[2] === '[]';
  const rawValue = readContinuation(st, trimmed.slice(kvMatch[0].length));
  const { value: valueStr, inlineComment } = splitValueAndComment(rawValue);
  const parsed = unquoteValue(valueStr);
  if (isArray && appendToArray(st, key, parsed)) return true;
  pushItem(st, {
    kind: 'kv',
    key,
    isArray,
    value: isArray ? [parsed] : parsed,
    sep: kvMatch[3],
    inlineComment,
  });
  return true;
}

// Bare key (no `=`): treat as empty-string value.
// Reject lines that look like a broken section header or an empty-key
// assignment — those are parse errors, not bare keys. (Blank lines are
// handled before, so `trimmed` is never empty here.)
function parseBareKey(trimmed: string, lineNo: number): IniKeyValue {
  if (trimmed.startsWith('[')) {
    throw new Error(`line ${lineNo}: malformed section header: ${trimmed}`);
  }
  if (trimmed.startsWith('=')) {
    throw new Error(
      `line ${lineNo}: key/value line with empty key: ${trimmed}`,
    );
  }
  const { value: bareKey, inlineComment: bareComment } =
    splitValueAndComment(trimmed);
  if (bareKey.includes('\0')) {
    throw new Error(`line ${lineNo}: INI key must not contain null bytes`);
  }
  return {
    kind: 'kv',
    key: bareKey,
    isArray: false,
    value: '',
    sep: '',
    inlineComment: bareComment,
  };
}

function parseLine(st: ParseState): void {
  const line = st.lines[st.i];
  const trimmed = line.trim();
  if (trimmed === '') {
    pushItem(st, { kind: 'blank' });
  } else if (COMMENT_LINE_RE.test(trimmed)) {
    pushItem(st, { kind: 'comment', raw: line });
  } else if (!parseSectionLine(st, trimmed) && !parseKvLine(st, trimmed)) {
    pushItem(st, parseBareKey(trimmed, st.i + 1));
  }
}

export function parseIniDoc(text: string): IniDocument {
  const rawLines = text.split(/\r?\n/);
  // Drop the trailing empty string that split() produces when text ends with \n
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines;
  const st: ParseState = { lines, i: 0, doc: { items: [] }, section: null };
  while (st.i < lines.length) {
    parseLine(st);
    st.i++;
  }
  return st.doc;
}
