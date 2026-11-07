/** Parsing of json/yaml/toml/ini merge options and template engine selection. */
import {
  IniMergeOptions,
  JsonMergeOptions,
  TemplateEngine,
  TomlMergeOptions,
  VALID_TEMPLATE_ENGINES,
  YamlMergeOptions,
} from '../types';
import { isPlainObject } from './validate';

const CONFLICT_VALUES = ['abort', 'first_wins', 'last_wins'] as const;
const ARRAY_VALUES = ['replace', 'concat', 'dedupe'] as const;
const OBJECT_VALUES = ['replace', 'merge'] as const;

type MergeKind = 'json' | 'yaml' | 'toml' | 'ini';

interface BaseMergeOptions {
  conflicts?: (typeof CONFLICT_VALUES)[number];
  arrays?: (typeof ARRAY_VALUES)[number];
  objects?: (typeof OBJECT_VALUES)[number];
}

// Validated in this order; the first failing option determines the error.
const STRATEGY_OPTIONS: ReadonlyArray<
  [keyof BaseMergeOptions, readonly string[]]
> = [
  ['conflicts', CONFLICT_VALUES],
  ['arrays', ARRAY_VALUES],
  ['objects', OBJECT_VALUES],
];

function parseMergeOptions(
  raw: unknown,
  loc: string,
  kind: MergeKind,
  extraKnownKeys: string[] = [],
): BaseMergeOptions {
  if (!isPlainObject(raw)) {
    throw new Error(`${loc}: "${kind}" must be an object`);
  }
  const opts: Record<string, unknown> = {};

  for (const [key, values] of STRATEGY_OPTIONS) {
    if (raw[key] === undefined) continue;
    if (!values.includes(raw[key] as string)) {
      throw new Error(
        `${loc}.${kind}.${key}: must be one of ${values.join(', ')}`,
      );
    }
    opts[key] = raw[key];
  }

  const knownKeys = new Set([
    'conflicts',
    'arrays',
    'objects',
    ...extraKnownKeys,
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new Error(`${loc}.${kind}.${key}: unknown option`);
    }
  }

  return opts;
}

const JSON_BOOLEAN_OPTIONS = [
  ['trailing_commas', 'trailingCommas'],
  ['sort_keys', 'sortKeys'],
  ['minify', 'minify'],
  ['strip_comments', 'stripComments'],
] as const;

function parseJsonIndent(value: unknown, loc: string): number | 'tab' {
  if (value === 'tab') return 'tab';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(
    `${loc}.json.indent: must be a non-negative integer or "tab"`,
  );
}

function parseJsonMergeOptions(raw: unknown, loc: string): JsonMergeOptions {
  const opts: JsonMergeOptions = parseMergeOptions(raw, loc, 'json', [
    'indent',
    'trailing_commas',
    'sort_keys',
    'minify',
    'strip_comments',
  ]);

  const r = raw as Record<string, unknown>;

  if ('indent' in r) {
    opts.indent = parseJsonIndent(r['indent'], loc);
  }

  for (const [yamlKey, tsKey] of JSON_BOOLEAN_OPTIONS) {
    if (yamlKey in r) {
      if (typeof r[yamlKey] !== 'boolean') {
        throw new Error(`${loc}.json.${yamlKey}: must be a boolean`);
      }
      opts[tsKey] = r[yamlKey];
    }
  }

  return opts;
}

const MERGE_PARSERS: Record<
  MergeKind,
  (raw: unknown, loc: string) => BaseMergeOptions
> = {
  json: parseJsonMergeOptions,
  yaml: (raw, loc) => parseMergeOptions(raw, loc, 'yaml'),
  toml: (raw, loc) => parseMergeOptions(raw, loc, 'toml'),
  ini: (raw, loc) => parseMergeOptions(raw, loc, 'ini'),
};

const MERGE_KINDS: readonly MergeKind[] = ['json', 'yaml', 'toml', 'ini'];

function parseTemplate(raw: unknown, loc: string): TemplateEngine | true {
  if (raw === true) return true;
  if (
    typeof raw !== 'string' ||
    !VALID_TEMPLATE_ENGINES.includes(raw as TemplateEngine)
  ) {
    throw new Error(
      `${loc}.template: must be true or one of ${VALID_TEMPLATE_ENGINES.join(', ')}`,
    );
  }
  return raw as TemplateEngine;
}

interface FormatOptions {
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
  toml?: TomlMergeOptions | boolean;
  ini?: IniMergeOptions | boolean;
  template?: TemplateEngine | true;
}

/**
 * Parses the `json`, `yaml`, `toml`, `ini` and `template` fields shared by
 * file and variable entries, assigning them onto `target` in that order.
 */
export function assignFormatOptions(
  target: FormatOptions,
  obj: Record<string, unknown>,
  loc: string,
): void {
  for (const kind of MERGE_KINDS) {
    const raw = obj[kind];
    if (raw === undefined) continue;
    target[kind] =
      raw === true || raw === false ? raw : MERGE_PARSERS[kind](raw, loc);
  }
  if (obj['template'] !== undefined) {
    target.template = parseTemplate(obj['template'], loc);
  }
}
