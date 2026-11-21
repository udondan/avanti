/** One pull fetch pass: fetches and processes every file entry of a config. */
import * as path from 'path';
import { SELF_KEY, isRemoteConfigSpec } from '../../config';
import { fetchSource, FetchResult, SourceFetchRecord } from '../../sources';
import { applyInsertModeTracked } from '../../processors/insert';
import { computeDiff, computeSymlinkDiff, FileDiff } from '../../diff';
import { WriteTarget } from '../../writer';
import {
  buildEntryPreVars,
  resolveFollowSymlink,
  resolveTargetPath,
} from '../../paths';
import { AvantiConfig, FileEntry, Variables } from '../../types';
import { InsertedFragment } from '../../history';
import { resolveBackupPath, resolveVars } from '../../variables';
import {
  errorMessage,
  LoopContext,
  planEntries,
  resolveLoopVars,
} from './common';
import {
  assertSingleSelfFile,
  entryConditionHolds,
  FileTarget,
  isInsertUnchanged,
  InsertFn,
  loadTemplate,
  registerSymlinkPending,
  reportSymlinkOverDirectory,
  resolveFileTarget,
  resolveSymlinkEntry,
  symlinkUnsupported,
  TemplateFn,
  transformContent,
} from './entry';
import { FileHookContext, ShaError } from './types';

export interface FetchLoopResult {
  writeTargets: WriteTarget[];
  allDiffs: FileDiff[];
  fileHookContexts: FileHookContext[];
  hasError: boolean;
  shaErrors: ShaError[];
  sourceRecordsByTarget: Map<string, SourceFetchRecord[]>;
  skippedPaths: Set<string>;
  hasUnresolvableSkippedPath: boolean;
  insertedFragments: Map<string, InsertedFragment>;
  selfContent?: string;
  selfMode?: string;
  selfSudo?: true | string;
  selfSourceRecords?: SourceFetchRecord[];
}

interface FetchLoopState {
  config: AvantiConfig;
  ctx: LoopContext;
  vars: Variables;
  out: FetchLoopResult;
  seenShaErrorLabels: Set<string>;
  pendingWrites: Map<string, Buffer>;
}

function emptyResult(): FetchLoopResult {
  return {
    writeTargets: [],
    allDiffs: [],
    fileHookContexts: [],
    hasError: false,
    shaErrors: [],
    sourceRecordsByTarget: new Map(),
    skippedPaths: new Set(),
    hasUnresolvableSkippedPath: false,
    insertedFragments: new Map(),
  };
}

function errorResult(): FetchLoopResult {
  return { ...emptyResult(), hasError: true };
}

export async function runFetchLoop(
  config: AvantiConfig,
  ctx: LoopContext,
): Promise<FetchLoopResult> {
  const vars = await resolveLoopVars(config, ctx);
  if (vars === undefined) return errorResult();
  const plan = planEntries(config, ctx, vars);
  if (plan === undefined) return errorResult();

  const state: FetchLoopState = {
    config,
    ctx,
    vars,
    out: emptyResult(),
    seenShaErrorLabels: new Set(),
    pendingWrites: new Map(),
  };
  // $self was condition-skipped: protect configPath from stale cleanup so a
  // previously-written config file is not restored or deleted on this run.
  if (plan.selfSkipped && !isRemoteConfigSpec(ctx.configPath)) {
    state.out.skippedPaths.add(ctx.configPath);
  }

  for (const [key, entry] of plan.entries) {
    try {
      await processEntry(state, key === SELF_KEY, entry);
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${errorMessage(err)}`,
      );
      state.out.hasError = true;
    }
  }
  return state.out;
}

async function processEntry(
  state: FetchLoopState,
  isSelf: boolean,
  entry: FileEntry,
): Promise<void> {
  const { workingDir } = state.ctx;
  const preVars = buildEntryPreVars(entry, isSelf, workingDir, state.vars);
  if (isSelf) {
    await processSelfEntry(state, entry, preVars);
    return;
  }
  if (!entryConditionHolds(entry, workingDir, state.vars, preVars)) {
    markSkippedTarget(state, entry);
    return;
  }
  // Symlink entries: resolve src path and create a symlink instead of
  // fetching and writing file content.
  if (entry.symlink) {
    processSymlinkEntry(state, entry, entry.symlink, preVars);
    return;
  }
  await processFileEntry(state, entry, preVars);
}

function warnUnresolvableSkipped(state: FetchLoopState): void {
  console.warn(
    `Warning: skipped entry has an unresolvable target path — stale cleanup disabled for this run.`,
  );
  state.out.hasUnresolvableSkippedPath = true;
}

function markSkippedTarget(state: FetchLoopState, entry: FileEntry): void {
  const { workingDir } = state.ctx;
  const { skippedPaths } = state.out;
  let symlinkPath: string;
  try {
    symlinkPath = resolveTargetPath(entry, '', workingDir, state.vars);
  } catch {
    warnUnresolvableSkipped(state);
    return;
  }
  skippedPaths.add(symlinkPath);
  // Also skip the resolved real path so stale cleanup doesn't treat
  // the symlink target as unmanaged when followSymlink is in use.
  // Skip for directory targets — resolveFollowSymlink throws on dir symlinks.
  // resolveFollowSymlink security errors (escape/directory/cycle) are
  // intentionally NOT caught here — they propagate as hard failures.
  const resolvedTarget = resolveVars(entry.target, state.vars);
  if (resolvedTarget.endsWith('/') || resolvedTarget.endsWith(path.sep)) {
    return;
  }
  const realPath = resolveFollowSymlink(symlinkPath, entry, workingDir);
  if (realPath !== symlinkPath) skippedPaths.add(realPath);
}

function backupPathFor(
  state: FetchLoopState,
  entry: FileEntry,
  diff: FileDiff,
  targetPath: string,
): string | undefined {
  if (!entry.backup || !diff.hasChanges || diff.isNew) return undefined;
  return resolveBackupPath(
    entry.backup,
    targetPath,
    state.ctx.workingDir,
    state.vars,
    state.config.backup_roots ?? [],
  );
}

function addHookContext(
  state: FetchLoopState,
  entry: FileEntry,
  diff: FileDiff,
  targetPath: string,
): void {
  if (entry.on && diff.hasChanges) {
    state.out.fileHookContexts.push({
      targetPath,
      hooks: entry.on,
      isNew: diff.isNew,
    });
  }
}

function processSymlinkEntry(
  state: FetchLoopState,
  entry: FileEntry,
  mode: true | 'absolute' | 'relative',
  preVars: Variables,
): void {
  const { out } = state;
  const { workingDir } = state.ctx;
  if (symlinkUnsupported(entry)) {
    out.hasError = true;
    return;
  }
  const link = resolveSymlinkEntry(
    entry,
    mode,
    workingDir,
    state.vars,
    preVars,
  );
  const { targetPath, symlinkTarget } = link;
  if (symlinkTarget === undefined) {
    // Mark the target as skipped so stale cleanup does not treat a
    // previously-managed path as unmanaged and delete/restore it.
    out.skippedPaths.add(targetPath);
    return;
  }
  const diff = computeSymlinkDiff(targetPath, symlinkTarget);
  // Symlinks cannot replace existing directories — error early so the
  // write batch is not attempted and EISDIR is not thrown at rename time.
  // Do not push to allDiffs here: allDiffs and writeTargets are parallel
  // arrays; pushing diff without a matching writeTargets entry would
  // misalign subsequent index-based lookups.
  if (diff.isDirectory) {
    reportSymlinkOverDirectory(entry, targetPath);
    out.hasError = true;
    return;
  }
  out.allDiffs.push(diff);
  const symlinkContent = Buffer.from(symlinkTarget, 'utf8');
  out.writeTargets.push({
    targetPath,
    content: symlinkContent,
    symlinkTarget,
    backupPath: backupPathFor(state, entry, diff, targetPath),
    sudo: entry.sudo,
  });
  addHookContext(state, entry, diff, targetPath);
  registerSymlinkPending(state.pendingWrites, link, workingDir, preVars);
}

function fetchEntry(
  state: FetchLoopState,
  entry: FileEntry,
  preVars: Variables,
  isSelf: boolean,
): Promise<FetchResult> {
  const { ctx } = state;
  return fetchSource(entry, ctx.workingDir, preVars, {
    cache: ctx.cache,
    getTargetPath: isSelf ? () => ctx.configPath : undefined,
    pendingWrites: state.pendingWrites,
    configBase: ctx.configBase,
  });
}

function collectShaErrors(
  state: FetchLoopState,
  records: SourceFetchRecord[],
): void {
  for (const rec of records) {
    if (rec.matched || state.seenShaErrorLabels.has(rec.sourceLabel)) continue;
    state.seenShaErrorLabels.add(rec.sourceLabel);
    state.out.shaErrors.push({
      sourceLabel: rec.sourceLabel,
      expectedSha: rec.expectedSha,
      observedSha: rec.observedSha,
    });
  }
}

async function processSelfEntry(
  state: FetchLoopState,
  entry: FileEntry,
  preVars: Variables,
): Promise<void> {
  const result = await fetchEntry(state, entry, preVars, true);
  collectShaErrors(state, result.sourceRecords);
  assertSingleSelfFile(result);
  const template = await loadTemplate(entry);
  const { out } = state;
  for (const [relPath, rawContent] of result.files) {
    // For $self the path resolution would fail (config path is absolute),
    // so we skip it and fall back to the base vars.
    const content = await transformContent(rawContent, {
      entry,
      vars: state.vars,
      relPath,
      template,
    });
    out.selfContent = content.toString('utf8');
    out.selfMode = entry.mode;
    out.selfSudo = entry.sudo || undefined;
    if (result.sourceRecords.length > 0) {
      out.selfSourceRecords = result.sourceRecords;
    }
  }
}

async function processFileEntry(
  state: FetchLoopState,
  entry: FileEntry,
  preVars: Variables,
): Promise<void> {
  const result = await fetchEntry(state, entry, preVars, false);
  if (result.allSkipped) {
    markSkippedTarget(state, entry);
    return;
  }
  collectShaErrors(state, result.sourceRecords);
  const template = await loadTemplate(entry);
  for (const [relPath, rawContent] of result.files) {
    await processFile(state, entry, result.sourceRecords, {
      relPath,
      rawContent,
      template,
    });
  }
}

interface FetchedFile {
  relPath: string;
  rawContent: Buffer;
  template: TemplateFn | undefined;
}

function insertStep(
  state: FetchLoopState,
  entry: FileEntry,
  target: FileTarget,
): InsertFn | undefined {
  if (entry.strategy !== 'insert') return undefined;
  const { targetPath, effectivePath } = target;
  const { skippedPaths, insertedFragments } = state.out;
  return (rawText, text) => {
    const lastInserted =
      state.ctx.history.getInsertedFragment(effectivePath) ?? null;
    if (isInsertUnchanged(lastInserted, rawText, text, effectivePath)) {
      skippedPaths.add(targetPath); // keep stale detection from treating this as missing
      if (effectivePath !== targetPath) skippedPaths.add(effectivePath);
      return undefined; // source and processed output unchanged — skip write entirely (no-op)
    }
    const inserted = applyInsertModeTracked(
      entry,
      text,
      lastInserted,
      effectivePath,
    );
    insertedFragments.set(effectivePath, {
      raw: rawText,
      processed: text,
      owned: inserted.owned,
    });
    return inserted.text;
  };
}

async function processFile(
  state: FetchLoopState,
  entry: FileEntry,
  records: SourceFetchRecord[],
  file: FetchedFile,
): Promise<void> {
  const { out } = state;
  const target = resolveFileTarget(
    entry,
    file.relPath,
    state.ctx.workingDir,
    state.vars,
  );
  const content = await transformContent(file.rawContent, {
    entry,
    vars: target.entryVars,
    relPath: file.relPath,
    template: file.template,
    insert: insertStep(state, entry, target),
  });
  if (content === undefined) return;
  const { targetPath, effectivePath: ep } = target;
  const diff = computeDiff(ep, content, entry.mode);
  out.allDiffs.push(diff);
  out.writeTargets.push({
    targetPath: ep,
    content,
    mode: entry.mode,
    backupPath: backupPathFor(state, entry, diff, ep),
    writeInPlace: entry.writeInPlace,
    sudo: entry.sudo,
  });
  addHookContext(state, entry, diff, ep);
  state.pendingWrites.set(ep, content);
  // Also index under the original symlink path so local source lookups
  // using the symlink path (not the resolved real path) still find the
  // pending content within the same fetch loop.
  if (ep !== targetPath) {
    state.pendingWrites.set(targetPath, content);
    // Mark the symlink path as covered so stale detection doesn't treat
    // a previously-tracked symlink path as stale when followSymlink is
    // enabled on an entry that was first pulled without it.
    out.skippedPaths.add(targetPath);
  }
  if (records.length > 0) {
    out.sourceRecordsByTarget.set(ep, records);
  }
}
