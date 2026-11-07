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

/** What a section (or the global part of a document) holds. */
export type IniSectionItem = IniComment | IniBlank | IniKeyValue;

export interface IniSection {
  kind: 'section';
  name: string; // e.g. "remote"
  subName?: string; // e.g. "origin" from [remote "origin"]
  headerComment?: string; // text after `]` on the header line
  items: IniSectionItem[];
}

export type IniItem = IniSectionItem | IniSection;
export type IniScalar = string | number | boolean;

export interface IniDocument {
  items: IniItem[];
}
