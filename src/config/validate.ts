/** Shared validation helpers for config parsing. */
import { Via } from '../types';

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && !!value;
}

/** Returns the value when it is a string, otherwise undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Returns the value when it is a non-empty string, otherwise undefined. */
export function optionalNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/** Throws when `value` is set but is not a string with non-whitespace content. */
export function assertOptionalHost(value: unknown, loc: string): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${loc}.host: must be a non-empty string`);
  }
}

/** Throws when `value` is set but is not a non-empty string. */
export function assertOptionalNonEmptyString(
  value: unknown,
  loc: string,
): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new Error(`${loc}: must be a non-empty string`);
  }
}

/** Returns true for `/regex/` style patterns (more than just the slashes). */
export function isRegexPattern(pattern: string): boolean {
  return pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');
}

export function parseSha(value: unknown, loc: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${loc}.sha: must be a string, got ${typeof value}`);
  }
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${loc}.sha: expected 64 hex characters, got "${value}"`);
  }
  return normalized;
}

const VALID_VIA: Via[] = ['api', 'cli'];

function parseViaArray(value: unknown[], loc: string): Via[] {
  if (value.length === 0) {
    throw new Error(`${loc}.via: array must not be empty`);
  }
  if (value.length > VALID_VIA.length) {
    throw new Error(
      `${loc}.via: array must not have more than ${VALID_VIA.length} entries`,
    );
  }
  const seen = new Set<Via>();
  return value.map((v, i) => {
    if (!VALID_VIA.includes(v as Via)) {
      throw new Error(
        `${loc}.via[${i}]: must be "api" or "cli", got "${String(v)}"`,
      );
    }
    if (seen.has(v as Via)) {
      throw new Error(`${loc}.via[${i}]: duplicate value "${String(v)}"`);
    }
    seen.add(v as Via);
    return v as Via;
  });
}

export function parseVia(value: unknown, loc: string): Via | Via[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (!VALID_VIA.includes(value as Via)) {
      throw new Error(`${loc}.via: must be "api" or "cli", got "${value}"`);
    }
    return value as Via;
  }
  if (Array.isArray(value)) {
    return parseViaArray(value, loc);
  }
  throw new Error(`${loc}.via: must be a string or array`);
}

export function parseFilter(
  obj: Record<string, unknown>,
  loc: string,
): string[] | undefined {
  if (obj['filter'] === undefined) return undefined;
  if (!Array.isArray(obj['filter'])) {
    throw new Error(`${loc}.filter: must be an array`);
  }
  if (obj['filter'].length === 0) {
    throw new Error(`${loc}.filter: must not be an empty array`);
  }
  return (obj['filter'] as unknown[]).map((entry, i) => {
    if (!isNonEmptyString(entry)) {
      throw new Error(`${loc}.filter[${i}]: must be a non-empty string`);
    }
    if (isRegexPattern(entry)) {
      try {
        new RegExp(entry.slice(1, -1));
      } catch (err) {
        throw new Error(
          `${loc}.filter[${i}]: invalid regex: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
    return entry;
  });
}

/** Returns `obj[key]` when it is a plain object, otherwise throws. */
export function requireObjectField(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
): Record<string, unknown> {
  const value = obj[key];
  if (!isPlainObject(value)) {
    throw new Error(`${loc}.${key}: must be an object`);
  }
  return value;
}

/** Returns `obj[key]` when it is a non-empty string, otherwise throws. */
export function requireStringField(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
): string {
  const value = obj[key];
  if (!isNonEmptyString(value)) {
    throw new Error(`${loc}.${key}: required string`);
  }
  return value;
}
