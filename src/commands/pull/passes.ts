/**
 * Pull fetch passes: the first pass, the `$self` stabilization loop and the
 * final pass over the stable config.
 */
import { isRemoteConfigSpec, parseConfigContent, SELF_KEY } from '../../config';
import { SourceFetchRecord } from '../../sources';
import { computeDiff } from '../../diff';
import { AvantiConfig } from '../../types';
import { errorMessage, filesWithoutSelf, LoopContext } from './common';
import { FetchLoopResult, runFetchLoop } from './fetch-loop';
import { mergeShaErrors, printShaErrors } from './sha';
import { PullOptions } from './types';

interface SelfSnapshot {
  content: string;
  mode?: string;
  sudo?: true | string;
  sourceRecords?: SourceFetchRecord[];
}

function snapshotSelf(pass: FetchLoopResult, content: string): SelfSnapshot {
  return {
    content,
    mode: pass.selfMode,
    sudo: pass.selfSudo,
    sourceRecords: pass.selfSourceRecords,
  };
}

/** Exits when a pass failed or (without --accept-changes) hit SHA mismatches. */
function checkPass(
  pass: FetchLoopResult,
  opts: PullOptions,
  abortMessage: string,
): void {
  if (pass.hasError) {
    console.error(abortMessage);
    process.exit(2);
  }
  // SHA validation — abort unless --accept-changes
  if (pass.shaErrors.length > 0 && !opts.acceptChanges) {
    printShaErrors(pass.shaErrors);
    console.error(
      '\nRun `avanti pull --accept-changes` to review the diff and update SHA values.',
    );
    process.exit(2);
  }
}

function parseSelfConfig(content: string): AvantiConfig {
  try {
    return parseConfigContent(content);
  } catch (err: unknown) {
    console.error(`$self config is invalid: ${errorMessage(err)}`);
    process.exit(2);
  }
}

/**
 * Keeps fetching $self until content converges and returns the stable config
 * together with the $self content that produced it.
 */
async function stabilizeSelf(
  state: FetchLoopResult,
  initial: SelfSnapshot,
  ctx: LoopContext,
  opts: PullOptions,
): Promise<{ config: AvantiConfig; self: SelfSnapshot }> {
  let prevSelfContent: string | undefined;
  let current = initial;
  for (;;) {
    const config = parseSelfConfig(current.content);
    // Stable when: merged config has no $self, or fetching $self produced
    // the same content as the previous iteration (fixed point reached).
    if (!(SELF_KEY in config.files) || current.content === prevSelfContent) {
      return { config, self: current };
    }
    console.log('$self config resolved; re-evaluating with merged config...');
    const next = await runFetchLoop(config, ctx);
    checkPass(
      next,
      opts,
      'Aborting due to errors in $self re-evaluated config.',
    );
    mergeShaErrors(state.shaErrors, next.shaErrors);
    if (next.selfContent === undefined) return { config, self: current };
    prevSelfContent = current.content;
    current = snapshotSelf(next, next.selfContent);
  }
}

function adoptPass(state: FetchLoopResult, pass: FetchLoopResult): void {
  state.writeTargets = pass.writeTargets;
  state.allDiffs = pass.allDiffs;
  state.fileHookContexts = pass.fileHookContexts;
  state.sourceRecordsByTarget = pass.sourceRecordsByTarget;
  state.insertedFragments = pass.insertedFragments;
  state.skippedPaths = pass.skippedPaths;
  if (pass.hasUnresolvableSkippedPath) state.hasUnresolvableSkippedPath = true;
  mergeShaErrors(state.shaErrors, pass.shaErrors);
}

/**
 * For local configs, write the stable $self content back to disk.
 * If the stable config also declares a file entry for configPath,
 * replace it with the stabilized $self content so the on-disk config
 * always matches what was actually used for this run.
 */
function writeBackSelf(
  state: FetchLoopResult,
  configPath: string,
  self: SelfSnapshot,
): void {
  const { writeTargets, allDiffs } = state;
  const selfBuf = Buffer.from(self.content, 'utf8');
  const existingIdx = writeTargets.findIndex(
    (t) => t.targetPath === configPath,
  );
  if (existingIdx === -1) {
    writeTargets.push({
      targetPath: configPath,
      content: selfBuf,
      mode: self.mode,
      sudo: self.sudo,
    });
    allDiffs.push(computeDiff(configPath, selfBuf, self.mode));
  } else {
    const existing = writeTargets[existingIdx];
    const resolvedSelfMode = self.mode ?? existing.mode;
    writeTargets[existingIdx] = {
      ...existing,
      content: selfBuf,
      mode: resolvedSelfMode,
      // Fall back to the existing target's sudo identity when $self
      // doesn't specify one, so a privileged config file keeps its
      // write privileges after $self stabilization.
      sudo: self.sudo ?? existing.sudo,
    };
    allDiffs[existingIdx] = computeDiff(configPath, selfBuf, resolvedSelfMode);
  }
  // Content comes from $self — attribute the config file write to the
  // $self sources so history reflects the actual origin.
  if (self.sourceRecords !== undefined) {
    state.sourceRecordsByTarget.set(configPath, self.sourceRecords);
  } else {
    state.sourceRecordsByTarget.delete(configPath);
  }
}

/**
 * Runs all fetch passes and returns the state to diff and apply. The first
 * pass result is the accumulator: later passes replace its write set and
 * merge their SHA errors into it.
 */
export async function fetchAllPasses(
  config: AvantiConfig,
  ctx: LoopContext,
  opts: PullOptions,
): Promise<FetchLoopResult> {
  const state = await runFetchLoop(config, ctx);
  checkPass(state, opts, 'Aborting due to errors.');
  if (state.selfContent === undefined) return state;

  // $self stabilization loop: keep fetching $self until content converges,
  // then fetch all non-$self file entries from the stable config.
  const stable = await stabilizeSelf(
    state,
    snapshotSelf(state, state.selfContent),
    ctx,
    opts,
  );
  // Fetch all non-$self entries from the stable config.
  const files = filesWithoutSelf(stable.config);
  if (Object.keys(files).length > 0) {
    const second = await runFetchLoop({ ...stable.config, files }, ctx);
    checkPass(second, opts, 'Aborting due to errors.');
    adoptPass(state, second);
  }
  if (!isRemoteConfigSpec(ctx.configPath)) {
    writeBackSelf(state, ctx.configPath, stable.self);
  }
  return state;
}
