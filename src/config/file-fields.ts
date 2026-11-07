/** Parsers for individual `files:` entry options. */
import { OnHooks, ReplaceRule } from '../types';
import { isDirectoryTarget } from './symlink';
import { isNonEmptyString, isPlainObject, isRegexPattern } from './validate';

export function parseMode(value: unknown, target: string): string | undefined {
  if (typeof value === 'number') {
    // 0o-prefixed YAML literals are normalized to quoted strings before parsing
    // (see preprocessing in parseConfigContent), so any remaining number is a
    // bare decimal like mode: 755, which is ambiguous and rejected.
    throw new Error(
      `files["${target}"].mode: ${value} is a bare decimal — use a quoted string like "0755" or YAML 0o notation (e.g. 0o755)`,
    );
  }
  if (typeof value !== 'string') return undefined;
  if (!/^[0-7]{1,4}$/.test(value)) {
    throw new Error(
      `files["${target}"].mode: "${value}" is not a valid octal string (expected 1–4 octal digits, e.g. "0755")`,
    );
  }
  return value;
}

const VALID_HOOK_KEYS = new Set<keyof OnHooks>([
  'write',
  'beforeWrite',
  'beforeCreate',
  'beforeUpdate',
  'create',
  'update',
]);

export function parseOnHooks(value: unknown, target: string): OnHooks {
  if (!isPlainObject(value)) {
    throw new Error(`files["${target}"].on: must be a mapping`);
  }
  const onHooks: OnHooks = Object.create(null) as OnHooks;
  for (const key of Object.keys(value)) {
    if (!VALID_HOOK_KEYS.has(key as keyof OnHooks)) {
      throw new Error(`files["${target}"].on: unknown key "${key}"`);
    }
    const hook = value[key];
    if (typeof hook !== 'string') {
      throw new Error(`files["${target}"].on.${key}: must be a string`);
    }
    onHooks[key as keyof OnHooks] = hook;
  }
  return onHooks;
}

export function parseSymlinkMode(
  value: unknown,
  target: string,
): true | 'absolute' | 'relative' {
  if (value !== true && value !== 'absolute' && value !== 'relative') {
    throw new Error(
      `files["${target}"].symlink: must be true, "absolute", or "relative"`,
    );
  }
  return value;
}

/** Returns the sudo setting, or undefined for `sudo: false`. */
export function parseSudo(
  value: unknown,
  target: string,
): true | string | undefined {
  if (value === true) return true;
  if (typeof value === 'string' && value.trim()) {
    if (value.trim().startsWith('-')) {
      throw new Error(
        `files["${target}"].sudo: username must not start with '-'`,
      );
    }
    return value.trim();
  }
  if (value !== false) {
    throw new Error(
      `files["${target}"].sudo: must be true or a non-empty username string`,
    );
  }
  return undefined;
}

export function parseStrategy(
  value: unknown,
  target: string,
): 'replace' | 'insert' {
  if (value !== 'replace' && value !== 'insert') {
    throw new Error(
      `files["${target}"].strategy: must be "replace" or "insert"`,
    );
  }
  return value;
}

function parseReplaceRule(r: unknown, target: string, j: number): ReplaceRule {
  if (!isPlainObject(r)) {
    throw new Error(`files["${target}"].replace[${j}]: must be an object`);
  }
  if (typeof r['from'] !== 'string') {
    throw new Error(
      `files["${target}"].replace[${j}]: "from" must be a string`,
    );
  }
  if (typeof r['to'] !== 'string') {
    throw new Error(`files["${target}"].replace[${j}]: "to" must be a string`);
  }
  return { from: r['from'], to: r['to'] };
}

export function parseReplaceRules(
  value: unknown,
  target: string,
): ReplaceRule[] {
  if (!Array.isArray(value)) {
    throw new Error(`files["${target}"]: "replace" must be an array`);
  }
  return (value as unknown[]).map((r, j) => parseReplaceRule(r, target, j));
}

function parseExtractPattern(pat: unknown, target: string, i: number): string {
  if (!isNonEmptyString(pat)) {
    throw new Error(
      `files["${target}"].extract[${i}]: must be a non-empty string`,
    );
  }
  if (isRegexPattern(pat)) {
    try {
      new RegExp(pat.slice(1, -1));
    } catch (err) {
      throw new Error(`files["${target}"].extract[${i}]: invalid regex`, {
        cause: err,
      });
    }
  }
  return pat;
}

interface ExtractContext {
  target: string;
  symlink: boolean;
  multiSrc: boolean;
}

export function parseExtract(
  value: unknown,
  { target, symlink, multiSrc }: ExtractContext,
): true | string[] {
  if (symlink) {
    throw new Error(
      `files["${target}"].symlink: cannot be combined with extract:`,
    );
  }
  if (multiSrc) {
    throw new Error(
      `files["${target}"].extract: cannot be used with a list of sources`,
    );
  }
  if (!isDirectoryTarget(target)) {
    throw new Error(
      `files["${target}"].extract: target must be a directory (end with "/") — archive extraction writes multiple files`,
    );
  }
  if (value === true) return true;
  if (!Array.isArray(value)) {
    throw new Error(
      `files["${target}"].extract: must be true or a non-empty array of patterns`,
    );
  }
  if (value.length === 0) {
    throw new Error(`files["${target}"].extract: must not be an empty array`);
  }
  return (value as unknown[]).map((pat, i) =>
    parseExtractPattern(pat, target, i),
  );
}
