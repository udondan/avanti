/** Parsing of `if:` / `ifAny:` condition blocks. */
import { Condition, OsPlatform } from '../types';
import { isNonEmptyString, isPlainObject } from './validate';

const VALID_OS_PLATFORMS: OsPlatform[] = [
  'linux',
  'mac',
  'windows',
  'darwin',
  'win32',
];

const CHECK_KEYS = ['os', 'exists', 'exec', 'target_exists'] as const;
const KNOWN_KEYS = new Set<string>([...CHECK_KEYS, 'not']);

interface ConditionFields {
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

function parseOs(value: unknown, loc: string): OsPlatform | OsPlatform[] {
  if (Array.isArray(value) && value.length === 0) {
    throw new Error(`${loc}.os: must not be an empty array`);
  }
  const platforms: unknown[] = Array.isArray(value) ? value : [value];
  for (const p of platforms) {
    if (!VALID_OS_PLATFORMS.includes(p as OsPlatform)) {
      throw new Error(
        `${loc}.os: must be one of ${VALID_OS_PLATFORMS.join(', ')}, got "${String(p)}"`,
      );
    }
  }
  return value as OsPlatform | OsPlatform[];
}

function parseNonEmptyCheck(value: unknown, loc: string, key: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${loc}.${key}: must be a non-empty string`);
  }
  return value;
}

function parseBooleanCheck(value: unknown, loc: string, key: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${loc}.${key}: must be a boolean`);
  }
  return value;
}

// Validated in this order; the first failing field determines the error.
const CONDITION_FIELDS: ReadonlyArray<
  [keyof Condition, (value: unknown, loc: string, key: string) => unknown]
> = [
  ['os', parseOs],
  ['exists', parseNonEmptyCheck],
  ['exec', parseNonEmptyCheck],
  ['target_exists', parseBooleanCheck],
  ['not', parseBooleanCheck],
];

function parseCondition(raw: unknown, loc: string): Condition {
  if (!isPlainObject(raw)) {
    throw new Error(`${loc}: must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`${loc}: unknown key "${key}"`);
    }
  }
  if (!CHECK_KEYS.some((k) => raw[k] !== undefined)) {
    throw new Error(
      `${loc}: must specify at least one of ${CHECK_KEYS.join(', ')}`,
    );
  }
  const cond: Record<string, unknown> = {};
  for (const [key, parse] of CONDITION_FIELDS) {
    if (raw[key] !== undefined) cond[key] = parse(raw[key], loc, key);
  }
  return cond;
}

export function parseConditionField(
  obj: Record<string, unknown>,
  loc: string,
): ConditionFields {
  const result: ConditionFields = {};
  if (obj['if'] !== undefined) {
    if (Array.isArray(obj['if'])) {
      if (obj['if'].length === 0) {
        throw new Error(`${loc}.if: must not be an empty array`);
      }
      result['if'] = (obj['if'] as unknown[]).map((c, i) =>
        parseCondition(c, `${loc}.if[${i}]`),
      );
    } else {
      result['if'] = parseCondition(obj['if'], `${loc}.if`);
    }
  }
  if (obj['ifAny'] !== undefined) {
    if (!Array.isArray(obj['ifAny'])) {
      throw new Error(`${loc}.ifAny: must be an array`);
    }
    if (obj['ifAny'].length === 0) {
      throw new Error(`${loc}.ifAny: must not be an empty array`);
    }
    result.ifAny = (obj['ifAny'] as unknown[]).map((c, i) =>
      parseCondition(c, `${loc}.ifAny[${i}]`),
    );
  }
  return result;
}

/** Copies parsed `if` / `ifAny` conditions onto `target` when present. */
export function assignConditions(
  target: ConditionFields,
  conds: ConditionFields,
): void {
  if (conds['if'] !== undefined) target['if'] = conds['if'];
  if (conds.ifAny !== undefined) target.ifAny = conds.ifAny;
}
