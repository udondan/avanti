import * as path from 'path';
import {
  FileEntry,
  FileSrc,
  IniMergeOptions,
  JsonMergeOptions,
  TomlMergeOptions,
  YamlMergeOptions,
} from '../types';
import { mergeJson, formatJson } from '../processors/json';
import { mergeYaml, formatYaml } from '../processors/yaml';
import { mergeToml, formatToml } from '../processors/toml';
import { mergeIni, formatIni } from '../processors/ini';
import { isBinary } from '../binary';
import { srcFilename } from './dispatch';

type FormatName = 'json' | 'yaml' | 'toml' | 'ini';

/** A structured format with its options bound, ready to merge or format. */
interface FormatHandler {
  name: FormatName;
  merge(parts: string[]): string;
  format(text: string): string;
}

const EXTENSIONS: Record<FormatName, Set<string>> = {
  json: new Set(['.json', '.jsonc']),
  yaml: new Set(['.yaml', '.yml']),
  toml: new Set(['.toml']),
  ini: new Set(['.ini', '.cfg']),
};

function hasExtension(name: string, format: FormatName): boolean {
  return EXTENSIONS[format].has(path.extname(name).toLowerCase());
}

function srcHasExtension(src: FileSrc, format: FormatName): boolean {
  const name = srcFilename(src);
  if (!name) return false;
  return hasExtension(name, format);
}

function resolveOptions<O extends object>(
  setting: boolean | O | undefined,
  srcs: FileSrc[],
  format: FormatName,
): O | null {
  if (setting === false) return null;
  if (setting === true) return {} as O;
  if (setting !== undefined && typeof setting === 'object') return setting;
  // Auto-detect: all sources have a file extension of this format
  if (srcs.length > 0 && srcs.every((s) => srcHasExtension(s, format))) {
    return {} as O;
  }
  return null;
}

export function resolveJsonOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): JsonMergeOptions | null {
  return resolveOptions(entry.json, srcs, 'json');
}

export function resolveYamlOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): YamlMergeOptions | null {
  return resolveOptions(entry.yaml, srcs, 'yaml');
}

export function resolveTomlOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): TomlMergeOptions | null {
  return resolveOptions(entry.toml, srcs, 'toml');
}

export function resolveIniOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): IniMergeOptions | null {
  return resolveOptions(entry.ini, srcs, 'ini');
}

interface FormatSpec {
  name: FormatName;
  resolve(entry: FileEntry, srcs: FileSrc[]): FormatHandler | null;
  /** Handler with default options, used for content-based auto-detection. */
  auto(): FormatHandler;
}

function formatSpec<O>(
  name: FormatName,
  resolve: (entry: FileEntry, srcs: FileSrc[]) => O | null,
  handler: (opts: O) => FormatHandler,
  defaults: O,
): FormatSpec {
  return {
    name,
    resolve: (entry, srcs) => {
      const opts = resolve(entry, srcs);
      return opts === null ? null : handler(opts);
    },
    auto: () => handler(defaults),
  };
}

// Precedence order: json, yaml, toml, ini.
const FORMAT_SPECS: readonly FormatSpec[] = [
  formatSpec<JsonMergeOptions>(
    'json',
    resolveJsonOptions,
    (opts) => ({
      name: 'json',
      merge: (parts) => mergeJson(parts, opts),
      format: (text) => formatJson(text, opts),
    }),
    {},
  ),
  formatSpec<YamlMergeOptions>(
    'yaml',
    resolveYamlOptions,
    (opts) => ({
      name: 'yaml',
      merge: (parts) => mergeYaml(parts, opts),
      format: (text) => formatYaml(text),
    }),
    {},
  ),
  formatSpec<TomlMergeOptions>(
    'toml',
    resolveTomlOptions,
    (opts) => ({
      name: 'toml',
      merge: (parts) => mergeToml(parts, opts),
      format: (text) => formatToml(text),
    }),
    {},
  ),
  formatSpec<IniMergeOptions>(
    'ini',
    resolveIniOptions,
    (opts) => ({
      name: 'ini',
      merge: (parts) => mergeIni(parts, opts),
      format: (text) => formatIni(text),
    }),
    {},
  ),
];

/** First format (by precedence) enabled for the entry and its sources. */
export function resolveFormat(
  entry: FileEntry,
  srcs: FileSrc[],
): FormatHandler | null {
  for (const spec of FORMAT_SPECS) {
    const handler = spec.resolve(entry, srcs);
    if (handler !== null) return handler;
  }
  return null;
}

/**
 * First format (by precedence) that is not explicitly disabled and matches
 * the extension of every given file name.
 */
export function detectFormatFromNames(
  entry: FileEntry,
  names: string[],
): FormatHandler | null {
  for (const spec of FORMAT_SPECS) {
    if (
      entry[spec.name] !== false &&
      names.every((n) => hasExtension(n, spec.name))
    ) {
      return spec.auto();
    }
  }
  return null;
}

/** Formats every file with the handler; binary files are rejected. */
export function formatFiles(
  handler: FormatHandler,
  files: Map<string, Buffer>,
): Map<string, Buffer> {
  const formatted = new Map<string, Buffer>();
  for (const [k, v] of files) {
    if (isBinary(v)) {
      throw new Error(
        `Binary file "${k}" cannot be formatted as ${handler.name}. Remove the format option or use a text source.`,
      );
    }
    formatted.set(k, Buffer.from(handler.format(v.toString('utf8')), 'utf8'));
  }
  return formatted;
}
