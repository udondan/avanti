/** The `avanti pull` command: fetch, review, apply and record. */
import { Command } from 'commander';
import {
  deriveConfigBase,
  loadConfig,
  normalizeConfigKey,
  parseVia,
  resolveConfigPath,
} from '../../config';
import { HistoryManager } from '../../history';
import { buildDateVars } from '../../variables';
import { closeAllSessions } from '../../writer';
import { AvantiConfig } from '../../types';
import { applyWrites, buildWritePlan } from './apply';
import { errorMessage, LoopContext, resolveWorkingDir } from './common';
import { runBeforeHooks } from './hooks';
import {
  recordPullHistory,
  saveInsertedFragments,
  stageHistory,
} from './history-record';
import { fetchAllPasses } from './passes';
import { assertNoSudoOnWindows, reviewChanges } from './review';
import { preApplyConfigShas, warnRemoteShaAccept, writeBackShas } from './sha';
import { detectStale } from './stale';
import { checkUnreadableTargets } from './sudo-preread';
import { openSudoSessions } from './sudo-sessions';
import { resolveLstatFailedTargets } from './sudo-stat';
import { PullOptions, PullRun } from './types';

async function loadConfigOrExit(
  configPath: string,
  via: ReturnType<typeof parseVia>,
): Promise<AvantiConfig> {
  try {
    return await loadConfig(configPath, via);
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(2);
  }
}

/** Loads the config, opens history and runs all fetch passes. */
async function preparePull(opts: PullOptions, cmd: Command): Promise<PullRun> {
  const configPath = resolveConfigPath(
    cmd.parent?.opts().config as string | undefined,
  );
  const workingDir = resolveWorkingDir(cmd);
  const via = parseVia(cmd.parent?.opts().via as string | undefined, '--via');
  const config = await loadConfigOrExit(configPath, via);

  const history = new HistoryManager(
    normalizeConfigKey(configPath),
    workingDir,
  );
  const historyAvailable = history.ensureStorageDir();
  const pullId = historyAvailable ? history.openPullSession() : null;

  const ctx: LoopContext = {
    workingDir,
    dateVars: buildDateVars(),
    cache: new Map(),
    configPath,
    history,
    configBase: deriveConfigBase(configPath),
  };
  const state = await fetchAllPasses(config, ctx, opts);
  return {
    opts,
    configPath,
    history,
    historyAvailable,
    pullId,
    state,
    stale: detectStale(history, historyAvailable, state),
    sessions: new Map(),
    preReads: new Map(),
  };
}

async function runPull(opts: PullOptions, cmd: Command): Promise<void> {
  const run = await preparePull(opts, cmd);
  assertNoSudoOnWindows(run);
  await reviewChanges(run);

  openSudoSessions(run);
  await resolveLstatFailedTargets(run);
  await checkUnreadableTargets(run);

  warnRemoteShaAccept(run);
  const sha = preApplyConfigShas(run);
  runBeforeHooks(run.state.fileHookContexts, run.sessions);

  // Compute write batches before staging so that sudo is available for v0
  // capture of unreadable first-seen files (history must record the
  // original content before it is overwritten).
  const plan = buildWritePlan(run);
  const staged = stageHistory(run);
  const { effectivelyCleaned, postWriteError } = await applyWrites(
    run,
    plan,
    staged,
  );
  // Close worker sessions — stdin close signals the worker to exit cleanly.
  closeAllSessions(run.sessions);

  // meta.sudo is updated by stageFileVersion for every file that was
  // actually written. No extra sync needed here: updating meta.sudo for
  // no-op targets would overwrite the privilege identity from the last
  // real write with a config value that was never applied to the file,
  // causing stale cleanup to run with the wrong credentials.

  // Save inserted fragments to history for future idempotency detection
  if (run.historyAvailable) {
    saveInsertedFragments(run.history, run.state.insertedFragments);
  }
  writeBackShas(run.configPath, sha);
  recordPullHistory(run, staged, effectivelyCleaned);

  if (postWriteError !== null) {
    console.error(postWriteError);
    process.exit(2);
  }
}

export function pullCommand(): Command {
  return new Command('pull')
    .description('Pull remote sources and write to local files')
    .option('-y, --yes', 'skip confirmation prompt')
    .option(
      '--accept-changes',
      'accept SHA mismatches, update SHA values in config, and apply changes',
    )
    .action(async (options: unknown, cmd: Command) => {
      await runPull(options as PullOptions, cmd);
    });
}
