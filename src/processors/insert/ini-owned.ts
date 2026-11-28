/** The shape of INI ownership records stored in history, and their validation. */
import type { IniScalar } from '../ini';
import { isPlainObject } from './util';

// ── INI ownership (what each pull added) ─────────────────────────────────────

export interface IniOwnedKv {
  key: string;
  isArray: boolean;
  value: IniScalar | IniScalar[];
  // Scalars only: how many nodes with the same key and value the file already
  // had before the pull and still has.
  shared?: number;
}

export interface IniOwnedSection {
  name: string;
  subName?: string;
  // Position among the sections with the same name, counted from the start.
  index: number;
  // How many sections had this name; the position is only trusted while the
  // file still has that many.
  count: number;
  // Keys the section had before the pull. They tell a section apart from a
  // user section that happens to hold the same values.
  others: string[];
  // True when the pull added the section itself, not only values in it.
  created: boolean;
  kvs: IniOwnedKv[];
}

export interface IniOwnership {
  format: 'ini';
  globals: IniOwnedKv[];
  sections: IniOwnedSection[];
}

function isIniScalar(v: unknown): v is IniScalar {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

function isOptionalCount(v: unknown): boolean {
  return v === undefined || (Number.isInteger(v) && (v as number) >= 0);
}

function isOwnedKvValue(isArray: unknown, value: unknown): boolean {
  return isArray
    ? Array.isArray(value) && value.every(isIniScalar)
    : isIniScalar(value);
}

function isIniOwnedKv(kv: unknown): boolean {
  return isPlainObject(kv) && hasIniOwnedKvFields(kv);
}

function hasIniOwnedKvFields(kv: Record<string, unknown>): boolean {
  const typed =
    typeof kv['key'] === 'string' && typeof kv['isArray'] === 'boolean';
  return (
    typed &&
    isOptionalCount(kv['shared']) &&
    isOwnedKvValue(kv['isArray'], kv['value'])
  );
}

function isIniOwnedKvList(v: unknown): v is IniOwnedKv[] {
  return Array.isArray(v) && v.every(isIniOwnedKv);
}

function isSectionPosition(index: unknown, count: unknown): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(count)) return false;
  return (index as number) >= 0 && (count as number) > (index as number);
}

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((k) => typeof k === 'string');
}

function isIniOwnedSection(s: unknown): boolean {
  return isPlainObject(s) && hasIniOwnedSectionFields(s);
}

function hasIniOwnedSectionFields(s: Record<string, unknown>): boolean {
  const named =
    typeof s['name'] === 'string' &&
    (s['subName'] === undefined || typeof s['subName'] === 'string');
  const content =
    isStringList(s['others']) &&
    typeof s['created'] === 'boolean' &&
    isIniOwnedKvList(s['kvs']);
  return named && isSectionPosition(s['index'], s['count']) && content;
}

export function isIniOwnership(v: unknown): v is IniOwnership {
  if (!isPlainObject(v) || v['format'] !== 'ini') return false;
  return (
    isIniOwnedKvList(v['globals']) &&
    Array.isArray(v['sections']) &&
    v['sections'].every(isIniOwnedSection)
  );
}
