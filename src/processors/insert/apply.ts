/** Insert mode entry points: dispatches on the target's structured format. */
import * as fs from 'fs';
import type { FileEntry, FileSrc } from '../../types';
import {
  resolveJsonOptions,
  resolveYamlOptions,
  resolveTomlOptions,
  resolveIniOptions,
} from '../../sources';
import { applyIniInsert, iniOwnershipOfNewFile } from './ini';
import { applyJsonInsert } from './json';
import { applyTomlInsert } from './toml';
import type { InsertHistory, InsertResult } from './types';
import { applyYamlInsert } from './yaml';

type InsertFormat = 'json' | 'yaml' | 'toml' | 'ini';

type OptionsResolver = (entry: FileEntry, srcs: FileSrc[]) => object | null;

// Checked in order; the first format with options wins. The resolvers are
// looked up at call time, not captured when this module loads.
const FORMAT_RESOLVERS: readonly (readonly [InsertFormat, OptionsResolver])[] =
  [
    ['json', (entry, srcs) => resolveJsonOptions(entry, srcs)],
    ['yaml', (entry, srcs) => resolveYamlOptions(entry, srcs)],
    ['toml', (entry, srcs) => resolveTomlOptions(entry, srcs)],
    ['ini', (entry, srcs) => resolveIniOptions(entry, srcs)],
  ];

type TextInsert = (
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
) => string;

const TEXT_INSERTS: Record<Exclude<InsertFormat, 'ini'>, TextInsert> = {
  json: applyJsonInsert,
  yaml: applyYamlInsert,
  toml: applyTomlInsert,
};

function resolveFormat(
  entry: FileEntry,
  srcs: FileSrc[],
): { format: InsertFormat; opts: Record<string, unknown> } | null {
  for (const [format, resolve] of FORMAT_RESOLVERS) {
    const opts = resolve(entry, srcs);
    if (opts !== null) return { format, opts: opts as Record<string, unknown> };
  }
  return null;
}

// Plain text: find old fragment in file and replace; otherwise append
function applyTextInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
): string {
  if (
    lastProcessed !== null &&
    lastProcessed.length > 0 &&
    existingContent.includes(lastProcessed)
  ) {
    const idx = existingContent.lastIndexOf(lastProcessed);
    return (
      existingContent.slice(0, idx) +
      processedText +
      existingContent.slice(idx + lastProcessed.length)
    );
  }
  const sep = existingContent.endsWith('\n') ? '' : '\n';
  return existingContent + sep + processedText;
}

export function applyInsertMode(
  entry: FileEntry,
  processedText: string,
  lastProcessed: string | null,
  targetPath: string,
): string {
  return applyInsertModeTracked(
    entry,
    processedText,
    lastProcessed === null ? null : { processed: lastProcessed },
    targetPath,
  ).text;
}

export function applyInsertModeTracked(
  entry: FileEntry,
  processedText: string,
  last: InsertHistory | null,
  targetPath: string,
): InsertResult {
  const lastProcessed = last?.processed ?? null;
  const srcs: FileSrc[] = Array.isArray(entry.src) ? entry.src : [entry.src];
  const resolved = resolveFormat(entry, srcs);

  if (!fs.existsSync(targetPath)) {
    return {
      text: processedText,
      ...(resolved?.format === 'ini'
        ? { owned: iniOwnershipOfNewFile(processedText) }
        : {}),
    };
  }
  const existingContent = fs.readFileSync(targetPath, 'utf8');

  if (resolved === null) {
    return {
      text: applyTextInsert(existingContent, processedText, lastProcessed),
    };
  }
  if (resolved.format === 'ini') {
    return applyIniInsert(existingContent, processedText, last, resolved.opts);
  }
  const insert = TEXT_INSERTS[resolved.format];
  return {
    text: insert(existingContent, processedText, lastProcessed, resolved.opts),
  };
}
