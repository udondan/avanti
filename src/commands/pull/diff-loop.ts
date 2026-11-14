/** The fetch pass of the `avanti diff` command (no writes, no history). */
import { SELF_KEY } from '../../config';
import { fetchSource, FetchResult, formatSourceLabel } from '../../sources';
import { applyInsertModeTracked } from '../../processors/insert';
import { computeDiff, computeSymlinkDiff, FileDiff } from '../../diff';
import { buildEntryPreVars } from '../../paths';
import { AvantiConfig, FileEntry, Variables } from '../../types';
import {
  errorMessage,
  LoopContext,
  planEntries,
  resolveLoopVars,
} from './common';
import {
  assertSingleSelfFile,
  entryConditionHolds,
  InsertFn,
  isInsertUnchanged,
  loadTemplate,
  registerSymlinkPending,
  reportSymlinkOverDirectory,
  resolveFileTarget,
  resolveSymlinkEntry,
  symlinkUnsupported,
  TemplateFn,
  transformContent,
} from './entry';

export interface DiffLoopResult {
  allDiffs: FileDiff[];
  hasError: boolean;
  selfContent?: string;
  selfMode?: string;
}

interface DiffLoopState {
  ctx: LoopContext;
  vars: Variables;
  out: DiffLoopResult;
  pendingWrites: Map<string, Buffer>;
}

/** One diff fetch pass: computes the diff of every file entry of a config. */
export async function runDiffLoop(
  config: AvantiConfig,
  ctx: LoopContext,
): Promise<DiffLoopResult> {
  const vars = await resolveLoopVars(config, ctx);
  if (vars === undefined) return { allDiffs: [], hasError: true };
  const plan = planEntries(config, ctx, vars);
  if (plan === undefined) return { allDiffs: [], hasError: true };

  const state: DiffLoopState = {
    ctx,
    vars,
    out: { allDiffs: [], hasError: false },
    pendingWrites: new Map(),
  };
  for (const [key, entry] of plan.entries) {
    try {
      await diffEntry(state, key === SELF_KEY, entry);
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${errorMessage(err)}`,
      );
      state.out.hasError = true;
    }
  }
  return state.out;
}

async function diffEntry(
  state: DiffLoopState,
  isSelf: boolean,
  entry: FileEntry,
): Promise<void> {
  const { workingDir } = state.ctx;
  const preVars = buildEntryPreVars(entry, isSelf, workingDir, state.vars);
  if (isSelf) {
    await diffSelfEntry(state, entry, preVars);
    return;
  }
  if (!entryConditionHolds(entry, workingDir, state.vars, preVars)) return;
  if (entry.symlink) {
    diffSymlinkEntry(state, entry, entry.symlink, preVars);
    return;
  }
  await diffFileEntry(state, entry, preVars);
}

function diffSymlinkEntry(
  state: DiffLoopState,
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
  if (link.symlinkTarget === undefined) return;
  const d = computeSymlinkDiff(link.targetPath, link.symlinkTarget);
  out.allDiffs.push(d);
  if (d.isDirectory) {
    reportSymlinkOverDirectory(entry, link.targetPath);
    out.hasError = true;
  }
  registerSymlinkPending(state.pendingWrites, link, workingDir, preVars);
}

async function fetchAndReport(
  state: DiffLoopState,
  entry: FileEntry,
  preVars: Variables,
  isSelf: boolean,
): Promise<FetchResult> {
  const { ctx } = state;
  const result = await fetchSource(entry, ctx.workingDir, preVars, {
    cache: ctx.cache,
    getTargetPath: isSelf ? () => ctx.configPath : undefined,
    pendingWrites: state.pendingWrites,
    configBase: ctx.configBase,
  });
  for (const rec of result.sourceRecords) {
    if (rec.matched) continue;
    console.error(
      `⚠  SHA mismatch for ${formatSourceLabel(rec.sourceLabel)}\n` +
        `   expected: ${rec.expectedSha}\n` +
        `   got:      ${rec.observedSha}`,
    );
  }
  return result;
}

async function diffSelfEntry(
  state: DiffLoopState,
  entry: FileEntry,
  preVars: Variables,
): Promise<void> {
  const result = await fetchAndReport(state, entry, preVars, true);
  assertSingleSelfFile(result);
  const template = await loadTemplate(entry);
  for (const [relPath, rawContent] of result.files) {
    const content = await transformContent(rawContent, {
      entry,
      vars: state.vars,
      relPath,
      template,
    });
    state.out.selfContent = content.toString('utf8');
    state.out.selfMode = entry.mode;
  }
}

async function diffFileEntry(
  state: DiffLoopState,
  entry: FileEntry,
  preVars: Variables,
): Promise<void> {
  const result = await fetchAndReport(state, entry, preVars, false);
  const template = await loadTemplate(entry);
  for (const [relPath, rawContent] of result.files) {
    await diffFile(state, entry, relPath, rawContent, template);
  }
}

function insertStep(
  state: DiffLoopState,
  entry: FileEntry,
  effectivePath: string,
): InsertFn | undefined {
  if (entry.strategy !== 'insert') return undefined;
  return (rawText, text) => {
    const lastInserted =
      state.ctx.history.getInsertedFragment(effectivePath) ?? null;
    // Source and processed output unchanged — would be a no-op write, skip diff
    if (isInsertUnchanged(lastInserted, rawText, text, effectivePath)) {
      return undefined;
    }
    return applyInsertModeTracked(entry, text, lastInserted, effectivePath)
      .text;
  };
}

async function diffFile(
  state: DiffLoopState,
  entry: FileEntry,
  relPath: string,
  rawContent: Buffer,
  template: TemplateFn | undefined,
): Promise<void> {
  const { targetPath, effectivePath, entryVars } = resolveFileTarget(
    entry,
    relPath,
    state.ctx.workingDir,
    state.vars,
  );
  const content = await transformContent(rawContent, {
    entry,
    vars: entryVars,
    relPath,
    template,
    insert: insertStep(state, entry, effectivePath),
  });
  if (content === undefined) return;
  state.out.allDiffs.push(computeDiff(effectivePath, content, entry.mode));
  state.pendingWrites.set(effectivePath, content);
  // Also index under the original symlink path so local source lookups
  // using the symlink path (not the resolved real path) still find the
  // pending content within the same diff loop.
  if (effectivePath !== targetPath) {
    state.pendingWrites.set(targetPath, content);
  }
}
