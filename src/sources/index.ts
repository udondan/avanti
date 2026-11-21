import * as path from 'path';
import { isVerbose, verbose } from '../logger';
import { redactUrl } from '../fetch';
import { FileEntry, FileSrc, Variables } from '../types';
import { evaluateConditions } from '../condition';
import { resolveTargetPath } from '../paths';
import { resolveVars } from '../variables';
import { isBinary } from '../binary';
import { applyFilter } from '../filter';
import { extractArchive, detectArchiveFormat } from '../extract';
import {
  cacheKeyForSrc,
  fetchRawSrc,
  filterForSrc,
  RawFetchResult,
  srcFilename,
} from './dispatch';
import { detectFormatFromNames, formatFiles, resolveFormat } from './formats';
import { pendingLocalFiles } from './pending';
import {
  buildRecord,
  compareCodeUnits,
  formatSourceLabel,
  labelForSrc,
  SourceFetchRecord,
} from './records';

export {
  resolveJsonOptions,
  resolveYamlOptions,
  resolveTomlOptions,
  resolveIniOptions,
} from './formats';
export { formatSourceLabel } from './records';
export type { SourceFetchRecord } from './records';

export interface FetchResult {
  files: Map<string, Buffer>;
  sourceRecords: SourceFetchRecord[];
  allSkipped?: boolean;
}

export type FetchCache = Map<string, { files: Map<string, Buffer> }>;

/** Everything needed to fetch one source of a file entry. */
interface SourceContext {
  workingDir: string;
  vars: Variables;
  cache: FetchCache | undefined;
  getTargetPath: () => string;
  pendingWrites: Map<string, Buffer> | undefined;
  configBase: string | undefined;
}

interface OneSrcResult {
  files: Map<string, Buffer>;
  record: SourceFetchRecord | null;
  skipped?: boolean;
}

function skippedResult(): FetchResult {
  return { files: new Map(), sourceRecords: [], allSkipped: true };
}

function sourceLabelForLog(src: FileSrc, vars: Variables): string {
  return redactUrl(formatSourceLabel(labelForSrc(src, vars)));
}

// Evaluate source-level conditions before the cache so a cached result for
// the same URL is not returned when conditions gate this source out.
function isGatedOut(src: FileSrc, ctx: SourceContext): boolean {
  if (typeof src === 'string') return false;
  const ifCond = 'if' in src ? (src as { if?: unknown })['if'] : undefined;
  const ifAnyCond =
    'ifAny' in src ? (src as { ifAny?: unknown }).ifAny : undefined;
  if (ifCond === undefined && ifAnyCond === undefined) return false;
  return !evaluateConditions(
    ifCond as Parameters<typeof evaluateConditions>[0],
    ifAnyCond as Parameters<typeof evaluateConditions>[1],
    ctx.getTargetPath,
    ctx.workingDir,
    ctx.vars,
  );
}

async function fetchCached(
  src: FileSrc,
  ctx: SourceContext,
): Promise<RawFetchResult> {
  const { vars, cache } = ctx;
  const cacheKey = cacheKeyForSrc(src, vars);
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) {
    if (isVerbose()) verbose(`cache hit: ${sourceLabelForLog(src, vars)}`);
    return { files: cached.files };
  }
  if (isVerbose()) verbose(`fetching source: ${sourceLabelForLog(src, vars)}`);
  const raw = await fetchRawSrc(src, ctx);
  // Don't cache skipped results: if optional changes to required between
  // stabilization iterations, a cached skipped result would mask the error.
  if (!raw.skipped) cache?.set(cacheKey, { files: raw.files });
  return raw;
}

function applySrcFilter(
  src: FileSrc,
  files: Map<string, Buffer>,
  vars: Variables,
): Map<string, Buffer> {
  const filterPatterns = filterForSrc(src)?.map((p) => resolveVars(p, vars));
  if (filterPatterns && filterPatterns.length > 0) {
    return applyFilter(files, filterPatterns);
  }
  return files;
}

async function fetchOneSrc(
  src: FileSrc,
  ctx: SourceContext,
): Promise<OneSrcResult> {
  if (isGatedOut(src, ctx)) {
    return { files: new Map(), record: null, skipped: true };
  }

  // Check pending writes before hitting the cache: a local path that is also a
  // write target in this run should resolve to the future content, not whatever
  // is on disk (or in the cache from a previous iteration).
  const pending =
    ctx.pendingWrites === undefined
      ? null
      : pendingLocalFiles(
          src,
          ctx.workingDir,
          ctx.vars,
          ctx.pendingWrites,
          ctx.configBase,
        );
  if (pending !== null) {
    return { files: pending, record: buildRecord(src, pending, ctx.vars) };
  }

  const raw = await fetchCached(src, ctx);
  if (raw.skipped) return { files: new Map(), record: null, skipped: true };

  const files = applySrcFilter(src, raw.files, ctx.vars);
  // Recompute record from the current source spec so expectedSha/matched
  // always reflect the caller's config iteration, not the first fetch.
  return { files, record: buildRecord(src, files, ctx.vars) };
}

// Asserts that all buffers in the map are text (not binary). Throws with a
// helpful message if any are binary, since merging/concatenating binary files
// is not supported.
function assertTextFiles(files: Map<string, Buffer>, context: string): void {
  for (const [name, buf] of files) {
    if (isBinary(buf)) {
      throw new Error(
        `Binary file "${name}" cannot be used in a multi-source merge (${context}). ` +
          `Use a single src entry for binary files.`,
      );
    }
  }
}

async function fetchListPart(
  src: FileSrc,
  index: number,
  ctx: SourceContext,
): Promise<{ text: string; record: SourceFetchRecord | null } | null> {
  try {
    const { files, record, skipped } = await fetchOneSrc(src, ctx);
    if (skipped) return null;
    assertTextFiles(files, `source ${index}`);
    const text = Array.from(files.values())
      .map((b) => b.toString('utf8'))
      .join('\n');
    return { text, record };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[source ${index}] ${msg}`, { cause: err });
  }
}

// List src → fetch each, then merge as JSON/YAML/TOML/INI or concatenate with
// newline
async function fetchSourceList(
  entry: FileEntry,
  srcs: FileSrc[],
  ctx: SourceContext,
): Promise<FetchResult> {
  const parts: string[] = [];
  const sourceRecords: SourceFetchRecord[] = [];
  for (let i = 0; i < srcs.length; i++) {
    const part = await fetchListPart(srcs[i], i, ctx);
    if (part === null) continue;
    parts.push(part.text);
    if (part.record !== null) sourceRecords.push(part.record);
  }
  if (parts.length === 0) return skippedResult();
  const filename = path.basename(entry.target);
  const handler = resolveFormat(entry, srcs);
  const content = handler === null ? parts.join('\n') : handler.merge(parts);
  return {
    files: new Map([[filename, Buffer.from(content, 'utf8')]]),
    sourceRecords,
  };
}

function extractNoMatchError(patterns: string[], cause: unknown): Error {
  const noun = patterns.length === 1 ? 'pattern' : 'patterns';
  const list = patterns.map((p) => JSON.stringify(p)).join(', ');
  return new Error(
    `extract matched no entries (${patterns.length} ${noun}: ${list})`,
    { cause },
  );
}

async function applyExtract(
  extract: NonNullable<FileEntry['extract']>,
  files: Map<string, Buffer>,
  vars: Variables,
): Promise<Map<string, Buffer>> {
  if (files.size !== 1) {
    throw new Error(
      `"extract" requires a single-file source, but source returned ${files.size} file(s)`,
    );
  }
  const [[archiveFilename, archiveBuffer]] = [...files.entries()];
  if (detectArchiveFormat(archiveFilename) === null) {
    throw new Error(
      `"extract" was specified but "${archiveFilename}" is not a recognised archive format`,
    );
  }
  const extracted = await extractArchive(archiveBuffer, archiveFilename);
  if (extract === true) return extracted;
  const resolvedPatterns = extract.map((p) => resolveVars(p, vars));
  try {
    return applyFilter(extracted, resolvedPatterns);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith('filter matched no files')
    ) {
      throw extractNoMatchError(resolvedPatterns, err);
    }
    throw err;
  }
}

function isSingleFileTarget(entry: FileEntry): boolean {
  return (
    entry.target !== undefined &&
    !entry.target.endsWith('/') &&
    !entry.target.endsWith(path.sep)
  );
}

// When a directory source resolves to multiple files but the target is a
// single file (no trailing slash), merge all files sorted by name instead
// of clobbering. Auto-detects JSON/YAML from the contained file extensions
// when no explicit merge option is set.
function mergeDirectory(
  entry: FileEntry,
  src: FileSrc,
  files: Map<string, Buffer>,
  sourceRecords: SourceFetchRecord[],
): FetchResult {
  const handler =
    resolveFormat(entry, [src]) ??
    detectFormatFromNames(entry, Array.from(files.keys()));
  if (handler === null) return { files, sourceRecords };
  assertTextFiles(files, 'directory merge');
  const sortedValues = Array.from(files.entries())
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, v]) => v.toString('utf8'));
  const filename = path.basename(entry.target);
  return {
    files: new Map([
      [filename, Buffer.from(handler.merge(sortedValues), 'utf8')],
    ]),
    sourceRecords,
  };
}

// Single src — delegate dispatch to fetchOneSrc, then apply post-processing
async function fetchSingleSource(
  entry: FileEntry,
  src: FileSrc,
  ctx: SourceContext,
): Promise<FetchResult> {
  const { files, record, skipped } = await fetchOneSrc(src, ctx);
  if (skipped) return skippedResult();

  const resolvedFiles =
    entry.extract === undefined
      ? files
      : await applyExtract(entry.extract, files, ctx.vars);
  const sourceRecords: SourceFetchRecord[] = record !== null ? [record] : [];

  if (resolvedFiles.size > 1 && isSingleFileTarget(entry)) {
    return mergeDirectory(entry, src, resolvedFiles, sourceRecords);
  }

  const handler = resolveFormat(entry, [src]);
  if (handler === null) return { files: resolvedFiles, sourceRecords };
  return { files: formatFiles(handler, resolvedFiles), sourceRecords };
}

/** Optional settings of {@link fetchSource}. */
interface FetchSourceOptions {
  cache?: FetchCache;
  getTargetPath?: () => string;
  pendingWrites?: Map<string, Buffer>;
  configBase?: string;
}

export async function fetchSource(
  entry: FileEntry,
  workingDir: string,
  vars: Variables = {},
  options: FetchSourceOptions = {},
): Promise<FetchResult> {
  const { cache, getTargetPath, pendingWrites, configBase } = options;
  const ctx: SourceContext = {
    workingDir,
    vars,
    cache,
    getTargetPath:
      getTargetPath ?? (() => resolveTargetPath(entry, '', workingDir, vars)),
    pendingWrites,
    configBase,
  };
  const { src } = entry;
  if (Array.isArray(src)) return fetchSourceList(entry, src, ctx);
  return fetchSingleSource(entry, src, ctx);
}

export const _testable = { srcFilename };
