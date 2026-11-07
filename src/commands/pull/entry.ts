/**
 * Per-entry helpers shared by the pull and diff fetch passes: conditions,
 * symlink entries, target resolution and content processors.
 */
import * as fs from 'fs';
import { evaluateConditions } from '../../condition';
import { FetchResult } from '../../sources';
import { applyReplace } from '../../processors/replace';
import { applyWriteHook } from '../../processors/on';
import { isBinary } from '../../binary';
import { resolveFollowSymlink, resolveTargetPath } from '../../paths';
import { FileEntry, LocalSrc, Variables } from '../../types';
import { resolveSymlinkSrcPath } from '../../sources/local';
import { InsertedFragment } from '../../history';
import { buildFileVars } from '../../variables';

export function entryConditionHolds(
  entry: FileEntry,
  workingDir: string,
  vars: Variables,
  preVars: Variables,
): boolean {
  return evaluateConditions(
    entry['if'],
    entry.ifAny,
    () => resolveTargetPath(entry, '', workingDir, vars),
    workingDir,
    preVars,
  );
}

/** Prints the Windows error and returns true when symlink entries are unsupported. */
export function symlinkUnsupported(entry: FileEntry): boolean {
  if (process.platform !== 'win32') return false;
  console.error(
    `Error processing ${JSON.stringify(entry.src)}: symlink entries are not supported on Windows; use an \`if: { os: [linux, mac] }\` condition to gate symlink entries in cross-platform configs`,
  );
  return true;
}

export function reportSymlinkOverDirectory(
  entry: FileEntry,
  targetPath: string,
): void {
  console.error(
    `Error processing ${JSON.stringify(entry.src)}: symlink: ${targetPath} is a directory; cannot replace with a symlink`,
  );
}

interface ResolvedSymlink {
  targetPath: string;
  rawSrc: string;
  /** Undefined when an optional local source does not exist. */
  symlinkTarget: string | undefined;
}

export function resolveSymlinkEntry(
  entry: FileEntry,
  mode: true | 'absolute' | 'relative',
  workingDir: string,
  vars: Variables,
  preVars: Variables,
): ResolvedSymlink {
  const targetPath = resolveTargetPath(entry, '', workingDir, vars);
  // Config validation guarantees a single local src for symlink entries.
  const rawSrc =
    typeof entry.src === 'string' ? entry.src : (entry.src as LocalSrc).path;

  // Honor optional: true — skip when the local source does not exist.
  const isOptionalSrc =
    !Array.isArray(entry.src) &&
    typeof entry.src !== 'string' &&
    !!(entry.src as LocalSrc).optional;
  if (isOptionalSrc) {
    const absSrc = resolveSymlinkSrcPath(
      rawSrc,
      workingDir,
      preVars,
      true,
      targetPath,
    );
    if (!fs.existsSync(absSrc)) {
      return { targetPath, rawSrc, symlinkTarget: undefined };
    }
  }

  const symlinkTarget = resolveSymlinkSrcPath(
    rawSrc,
    workingDir,
    preVars,
    mode,
    targetPath,
  );
  return { targetPath, rawSrc, symlinkTarget };
}

/**
 * Registers the resolved src content (not the symlink target string) in
 * pendingWrites so subsequent local entries that read through this symlink
 * path see the actual file bytes, not the raw symlink target path.
 */
export function registerSymlinkPending(
  pendingWrites: Map<string, Buffer>,
  link: ResolvedSymlink,
  workingDir: string,
  preVars: Variables,
): void {
  const absSymlinkSrc = resolveSymlinkSrcPath(
    link.rawSrc,
    workingDir,
    preVars,
    true,
    link.targetPath,
  );
  try {
    const srcStat = fs.statSync(absSymlinkSrc, { throwIfNoEntry: false });
    if (srcStat?.isFile()) {
      pendingWrites.set(link.targetPath, fs.readFileSync(absSymlinkSrc));
    }
  } catch {
    // src not readable — omit from pendingWrites
  }
}

export function assertSingleSelfFile(result: FetchResult): void {
  if (result.files.size !== 1) {
    throw new Error(
      `$self must resolve to exactly one file, got ${result.files.size}. Use yaml: true or json: true to merge multiple sources into one.`,
    );
  }
}

export type TemplateFn = (
  text: string,
  vars: Variables,
  relPath: string,
) => Promise<string>;

export async function loadTemplate(
  entry: FileEntry,
): Promise<TemplateFn | undefined> {
  const spec = entry.template;
  if (spec === undefined) return undefined;
  const { applyTemplate } = await import('../../processors/template');
  return (text, vars, relPath) =>
    applyTemplate(text, spec, vars, relPath || undefined);
}

export interface FileTarget {
  targetPath: string;
  /** targetPath with any symlink resolved (followSymlink). */
  effectivePath: string;
  entryVars: Variables;
}

export function resolveFileTarget(
  entry: FileEntry,
  relPath: string,
  workingDir: string,
  vars: Variables,
): FileTarget {
  // Compute the target path early so per-file vars ($path, $filename,
  // $basename, $ext, $dirname, $basedir) are available in processors.
  const targetPath = resolveTargetPath(entry, relPath, workingDir, vars);
  const entryVars = Object.assign(
    Object.create(null) as Variables,
    vars,
    buildFileVars(targetPath),
  );
  // Resolve any symlink on the target path early so insert-mode tracking
  // and all subsequent operations use the real file path consistently.
  const effectivePath = resolveFollowSymlink(targetPath, entry, workingDir);
  return { targetPath, effectivePath, entryVars };
}

/** Insert step: returns the new text, or undefined to skip the file. */
export type InsertFn = (rawText: string, text: string) => string | undefined;

interface TransformOptions {
  entry: FileEntry;
  vars: Variables;
  relPath: string;
  template: TemplateFn | undefined;
  insert?: InsertFn;
}

/**
 * Runs the text processors on fetched content. Returns undefined when the
 * insert step decides the file needs no write.
 */
export async function transformContent(
  rawContent: Buffer,
  opts: TransformOptions & { insert?: never },
): Promise<Buffer>;
export async function transformContent(
  rawContent: Buffer,
  opts: TransformOptions,
): Promise<Buffer | undefined>;
export async function transformContent(
  rawContent: Buffer,
  opts: TransformOptions,
): Promise<Buffer | undefined> {
  // Processors only operate on text; binary files are passed through unchanged.
  if (isBinary(rawContent)) return rawContent;
  const { entry, vars } = opts;
  const rawText = rawContent.toString('utf8');
  let text = rawText;
  if (opts.template !== undefined) {
    text = await opts.template(text, vars, opts.relPath);
  }
  if (entry.replace?.length) text = applyReplace(text, entry.replace, vars);
  if (entry.on?.write) text = applyWriteHook(text, entry.on.write, vars);
  if (opts.insert !== undefined) {
    const inserted = opts.insert(rawText, text);
    if (inserted === undefined) return undefined;
    text = inserted;
  }
  return Buffer.from(text, 'utf8');
}

/** True when neither the source nor the processed output changed since the last insert. */
export function isInsertUnchanged(
  lastInserted: InsertedFragment | null,
  rawText: string,
  text: string,
  effectivePath: string,
): boolean {
  if (lastInserted === null) return false;
  return (
    rawText === lastInserted.raw &&
    text === lastInserted.processed &&
    fs.existsSync(effectivePath)
  );
}
