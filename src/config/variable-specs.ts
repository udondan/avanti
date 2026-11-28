/** Parsing of the top-level `variables:` and `environment:` maps. */
import {
  EnvironmentEntry,
  EnvironmentSpec,
  VariableEntry,
  VariableSpec,
  VariableValue,
} from '../types';
import { RESERVED_VAR_NAMES, validateVariables } from '../variables';
import { validateEnvironmentNames } from '../environment';
import { assignFormatOptions } from './merge-options';
import { parseSrcField } from './sources';
import { isPlainObject } from './validate';

function plainJsonKeyPart(k: string): string {
  return /[.[\]"']/.test(k)
    ? `["${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    : `.${k}`;
}

// Recursively assert that a value is a valid JsonValue — no class instances
// (e.g. Set from a !!set YAML tag) anywhere in the tree.
function assertPlainJsonValue(val: unknown, path: string): void {
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      assertPlainJsonValue(val[i], `${path}[${i}]`);
    }
    return;
  }
  const proto = Object.getPrototypeOf(val) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const name =
      (val as { constructor?: { name?: string } }).constructor?.name ??
      'unknown';
    throw new Error(
      `${path}: expected a plain object but got ${name} — variable values must be strings, numbers, booleans, lists, or plain objects`,
    );
  }
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    assertPlainJsonValue(v, path + plainJsonKeyPart(k));
  }
}

/** `src` is a reserved key: any object with a top-level `src` key is source-backed. */
function isSourceObject(val: unknown): val is Record<string, unknown> {
  return isPlainObject(val) && Object.hasOwn(val, 'src');
}

function requireSrc(obj: Record<string, unknown>, loc: string): unknown {
  const rawSrc = obj['src'];
  if (rawSrc === undefined || rawSrc === null) {
    throw new Error(`${loc}: "src" is required`);
  }
  return rawSrc;
}

function parseVariableEntry(
  obj: Record<string, unknown>,
  varName: string,
): VariableEntry {
  const loc = `variables.${varName}`;
  const rawSrc = requireSrc(obj, loc);
  const entry: VariableEntry = { src: parseSrcField(rawSrc, loc) };
  assignFormatOptions(entry, obj, loc);
  return entry;
}

// Lists and plain objects (typeof 'object') as well as scalar numbers/booleans.
const PLAIN_VALUE_TYPES = new Set(['number', 'boolean', 'object']);

function parseVariableValue(
  key: string,
  val: unknown,
): VariableValue | VariableEntry {
  if (typeof val === 'string') return val;
  if (isSourceObject(val)) {
    // `src` is a reserved key: any object with a top-level `src` key is
    // treated as a source-backed VariableEntry, not a plain data object.
    return parseVariableEntry(val, key);
  }
  if (val !== null && PLAIN_VALUE_TYPES.has(typeof val)) {
    assertPlainJsonValue(val, `variables.${key}`);
    return val as VariableValue;
  }
  throw new Error(
    `variables.${key}: value must be a string, number, boolean, list, object, or source object with "src"`,
  );
}

export function parseVariables(raw: unknown): VariableSpec {
  if (raw === undefined || raw === null)
    return Object.create(null) as VariableSpec;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '"variables" must be a map of variable names to string values or source objects',
    );
  }
  const spec: VariableSpec = Object.create(null) as VariableSpec;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    spec[key] = parseVariableValue(key, val);
  }
  validateVariables(spec);
  return spec;
}

const ENV_UNSUPPORTED_KEYS = ['json', 'yaml', 'toml', 'ini', 'template'];

function parseEnvironmentEntry(
  obj: Record<string, unknown>,
  envName: string,
): EnvironmentEntry {
  const loc = `environment.${envName}`;
  const rawSrc = requireSrc(obj, loc);
  for (const key of ENV_UNSUPPORTED_KEYS) {
    if (obj[key] !== undefined) {
      throw new Error(
        `${loc}.${key}: not supported on "environment" entries — use "variables" instead if you need structured merging`,
      );
    }
  }
  return { src: parseSrcField(rawSrc, loc) };
}

function parseEnvironmentValue(
  key: string,
  val: unknown,
): string | EnvironmentEntry {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (isSourceObject(val)) {
    // `src` is a reserved key: any object with a top-level `src` key is
    // treated as a source-backed EnvironmentEntry.
    return parseEnvironmentEntry(val, key);
  }
  throw new Error(
    `environment.${key}: value must be a string, number, boolean, or source object with "src"`,
  );
}

export function parseEnvironment(raw: unknown): EnvironmentSpec {
  if (raw === undefined || raw === null)
    return Object.create(null) as EnvironmentSpec;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '"environment" must be a map of environment variable names to string values or source objects',
    );
  }
  const spec: EnvironmentSpec = Object.create(null) as EnvironmentSpec;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    spec[key] = parseEnvironmentValue(key, val);
  }
  validateEnvironmentNames(spec);
  // Environment values are merged into the same $name namespace as
  // variables, so the system-injected/reserved sentinel names apply here too.
  for (const name of Object.keys(spec)) {
    if (RESERVED_VAR_NAMES.has(name)) {
      throw new Error(
        `Environment variable name "${name}" is reserved and cannot be used`,
      );
    }
  }
  return spec;
}
