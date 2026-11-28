import { Command } from 'commander';
import {
  deriveConfigBase,
  isRemoteConfigSpec,
  loadConfig,
  normalizeConfigKey,
  parseConfigContent,
  parseVia,
  resolveConfigPath,
  SELF_KEY,
} from '../config';
import {
  computeDiff,
  computeDeleteDiff,
  computeSymlinkDiff,
  FileDiff,
  printDiffs,
} from '../diff';
import { AvantiConfig } from '../types';
import { HistoryManager } from '../history';
import { buildDateVars } from '../variables';
import {
  errorMessage,
  filesWithoutSelf,
  LoopContext,
  resolveWorkingDir,
} from './pull/common';
import { DiffLoopResult, runDiffLoop } from './pull/diff-loop';

interface SelfResolution {
  /** Undefined when a re-evaluation pass failed. */
  config: AvantiConfig | undefined;
  content: string;
  mode: string | undefined;
}

function parseSelfConfig(content: string): AvantiConfig {
  try {
    return parseConfigContent(content);
  } catch (err: unknown) {
    console.error(`$self config is invalid: ${errorMessage(err)}`);
    process.exit(2);
  }
}

/** Re-fetches `$self` until its content converges (fixed point). */
async function stabilizeSelf(
  ctx: LoopContext,
  content: string,
  mode: string | undefined,
): Promise<SelfResolution> {
  let prevContent: string | undefined;
  let current = { content, mode };
  for (;;) {
    const config = parseSelfConfig(current.content);
    // Stable when: merged config has no $self, or fetching $self produced
    // the same content as the previous iteration (fixed point reached).
    if (!(SELF_KEY in config.files) || current.content === prevContent) {
      return { config, ...current };
    }
    console.log('$self config resolved; re-evaluating with merged config...');
    const next = await runDiffLoop(config, ctx);
    if (next.hasError) return { config: undefined, ...current };
    if (next.selfContent === undefined) return { config, ...current };
    prevContent = current.content;
    current = { content: next.selfContent, mode: next.selfMode };
  }
}

/** Replaces (or adds) the config file diff with the stable `$self` content. */
function setSelfDiff(
  allDiffs: FileDiff[],
  configPath: string,
  self: SelfResolution,
): void {
  const diff = computeDiff(
    configPath,
    Buffer.from(self.content, 'utf8'),
    self.mode,
  );
  const existingIdx = allDiffs.findIndex((d) => d.targetPath === configPath);
  if (existingIdx === -1) {
    allDiffs.push(diff);
  } else {
    allDiffs[existingIdx] = diff;
  }
}

/** Runs the second pass over the stable `$self` config. */
async function diffStableConfig(
  ctx: LoopContext,
  self: SelfResolution & { config: AvantiConfig },
  pass: DiffLoopResult,
): Promise<DiffLoopResult> {
  let result = pass;
  const files = filesWithoutSelf(self.config);
  if (Object.keys(files).length > 0) {
    const second = await runDiffLoop({ ...self.config, files }, ctx);
    result = { allDiffs: second.allDiffs, hasError: second.hasError };
  }
  if (!isRemoteConfigSpec(ctx.configPath)) {
    setSelfDiff(result.allDiffs, ctx.configPath, self);
  }
  return result;
}

async function diffAllPasses(
  config: AvantiConfig,
  ctx: LoopContext,
): Promise<DiffLoopResult> {
  const first = await runDiffLoop(config, ctx);
  if (first.hasError) process.exit(2);
  if (first.selfContent === undefined) return first;
  const self = await stabilizeSelf(ctx, first.selfContent, first.selfMode);
  const { config: stable } = self;
  if (stable === undefined) return { ...first, hasError: true };
  return diffStableConfig(ctx, { ...self, config: stable }, first);
}

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

async function runDiff(
  pullId: string | undefined,
  cmd: Command,
): Promise<void> {
  const configPath = resolveConfigPath(
    cmd.parent?.opts().config as string | undefined,
  );
  const workingDir = resolveWorkingDir(cmd);
  const via = parseVia(cmd.parent?.opts().via as string | undefined, '--via');

  if (pullId !== undefined) {
    diffAgainstHistory(pullId, normalizeConfigKey(configPath), workingDir);
    return;
  }

  const config = await loadConfigOrExit(configPath, via);
  const ctx: LoopContext = {
    workingDir,
    dateVars: buildDateVars(),
    cache: new Map(),
    configPath,
    history: new HistoryManager(normalizeConfigKey(configPath), workingDir),
    configBase: deriveConfigBase(configPath),
  };
  const { allDiffs, hasError } = await diffAllPasses(config, ctx);

  printDiffs(allDiffs);

  const hasChanges = allDiffs.some((d) => d.hasChanges);
  if (hasError) process.exit(2);
  process.exit(hasChanges ? 1 : 0);
}

export function diffCommand(): Command {
  return new Command('diff')
    .description(
      'Show diff between remote sources and local files, or between local files and a past pull',
    )
    .argument(
      '[pullId]',
      'show diff between current files and a past pull state',
    )
    .action(
      async (pullId: string | undefined, _options: unknown, cmd: Command) => {
        await runDiff(pullId, cmd);
      },
    );
}

function diffAgainstHistory(
  pullId: string,
  configPath: string,
  workingDir: string,
): void {
  const history = new HistoryManager(
    normalizeConfigKey(configPath),
    workingDir,
  );
  if (!history.hasHistory()) {
    console.error('No history found. Run avanti pull first.');
    process.exit(2);
  }

  const pulls = history.listPulls();
  const matchedPull = pulls.find(
    (p) => p.pullId === pullId || p.pullId.startsWith(pullId),
  );
  if (!matchedPull) {
    console.error(`No pull found matching ID "${pullId}".`);
    process.exit(2);
  }

  const snapshot = history.getFilesAtPull(matchedPull.pullId);
  if (snapshot.size === 0) {
    console.log('No changes would result from reverting to this pull.');
    process.exit(0);
  }

  const diffs: FileDiff[] = [];
  for (const [absolutePath, { version, isSymlink }] of snapshot) {
    const historicalContent = history.readVersion(absolutePath, version);
    if (historicalContent === null) continue;
    if (isSymlink) {
      diffs.push(
        computeSymlinkDiff(absolutePath, historicalContent.toString('utf8')),
      );
    } else {
      diffs.push(computeDiff(absolutePath, historicalContent));
    }
  }

  // Also account for files that would be deleted (tracked files not in this snapshot)
  const allTracked = history.listTrackedFiles();
  const snapshotPaths = new Set(snapshot.keys());
  for (const meta of allTracked) {
    if (snapshotPaths.has(meta.absolutePath)) continue;
    // This file was created after the target pull — show it as a deletion
    diffs.push(computeDeleteDiff(meta.absolutePath));
  }

  printDiffs(diffs);
  const hasChanges = diffs.some((d) => d.hasChanges);
  process.exit(hasChanges ? 1 : 0);
}
