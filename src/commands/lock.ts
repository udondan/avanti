import { Command } from 'commander';
import {
  deriveConfigBase,
  isRemoteConfigSpec,
  loadConfig,
  resolveConfigPath,
  SELF_KEY,
} from '../config';
import { evaluateConditions } from '../condition';
import { fetchSource, formatSourceLabel } from '../sources';
import { buildEntryPreVars, resolveTargetPath } from '../paths';
import { writeUpdatedShas } from '../config-writeback';
import { resolveVariablesAndEnvironment } from '../context';
import { buildDateVars } from '../variables';
import { AvantiConfig, FileEntry, Variables } from '../types';
import { applyBaseVars, errorMessage, resolveWorkingDir } from './pull/common';

interface LockContext {
  configPath: string;
  workingDir: string;
  configBase: string;
  vars: Variables;
  force: boolean;
}

interface PinScan {
  /** label → sha */
  toPin: Map<string, string>;
  hasError: boolean;
  remoteSourceCount: number;
}

async function loadLocalConfig(configPath: string): Promise<AvantiConfig> {
  if (isRemoteConfigSpec(configPath)) {
    console.error('avanti lock requires a local config file.');
    process.exit(2);
  }
  try {
    return await loadConfig(configPath);
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(2);
  }
}

async function resolveLockVars(
  config: AvantiConfig,
  configPath: string,
  workingDir: string,
  configBase: string,
): Promise<Variables> {
  let vars: Variables;
  try {
    ({ vars } = await resolveVariablesAndEnvironment(
      config.variables ?? {},
      config.environment ?? {},
      workingDir,
      undefined,
      configBase,
    ));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(2);
  }
  applyBaseVars(vars, configPath, buildDateVars(), workingDir);
  return vars;
}

async function scanEntry(
  ctx: LockContext,
  scan: PinScan,
  isSelf: boolean,
  entry: FileEntry,
): Promise<void> {
  const { configPath, workingDir, vars } = ctx;
  const preVars = buildEntryPreVars(entry, isSelf, workingDir, vars);
  const conditionHolds = evaluateConditions(
    entry['if'],
    entry.ifAny,
    () =>
      isSelf ? configPath : resolveTargetPath(entry, '', workingDir, vars),
    workingDir,
    preVars,
  );
  if (!conditionHolds) return;
  const result = await fetchSource(entry, workingDir, preVars, {
    getTargetPath: isSelf ? () => configPath : undefined,
    configBase: ctx.configBase,
  });
  scan.remoteSourceCount += result.sourceRecords.length;
  for (const rec of result.sourceRecords) {
    if (!ctx.force && rec.expectedSha !== undefined) continue;
    scan.toPin.set(rec.sourceLabel, rec.observedSha);
  }
}

async function scanPins(
  config: AvantiConfig,
  ctx: LockContext,
): Promise<PinScan> {
  const scan: PinScan = {
    toPin: new Map(),
    hasError: false,
    remoteSourceCount: 0,
  };
  for (const [key, entry] of Object.entries(config.files)) {
    try {
      await scanEntry(ctx, scan, key === SELF_KEY, entry);
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${errorMessage(err)}`,
      );
      scan.hasError = true;
    }
  }
  return scan;
}

function reportNothingToPin(scan: PinScan): never {
  if (scan.hasError) process.exit(2);
  if (scan.remoteSourceCount === 0) {
    console.log('No SHA-pinnable remote sources found in config.');
  } else {
    console.log(
      'All remote sources already have SHA values pinned. Use --force to overwrite.',
    );
  }
  process.exit(0);
}

function writePins(configPath: string, toPin: Map<string, string>): void {
  const pinned = writeUpdatedShas(configPath, toPin);
  if (!pinned) {
    console.log('All SHA values are already up to date.');
    return;
  }
  for (const [label, sha] of toPin) {
    console.log(`  pinned  ${formatSourceLabel(label)}  ${sha.slice(0, 16)}`);
  }
  console.log(`\nPinned ${toPin.size} source(s).`);
}

async function runLock(force: boolean, cmd: Command): Promise<void> {
  const configPath = resolveConfigPath(
    cmd.parent?.opts().config as string | undefined,
  );
  const workingDir = resolveWorkingDir(cmd);
  const config = await loadLocalConfig(configPath);
  const configBase = deriveConfigBase(configPath);
  const vars = await resolveLockVars(
    config,
    configPath,
    workingDir,
    configBase,
  );
  const scan = await scanPins(config, {
    configPath,
    workingDir,
    configBase,
    vars,
    force,
  });

  if (scan.toPin.size === 0) reportNothingToPin(scan);

  if (scan.hasError) {
    console.error(
      'Aborting: one or more sources failed to fetch. No changes written.',
    );
    process.exit(2);
  }

  writePins(configPath, scan.toPin);
  process.exit(0);
}

export function lockCommand(): Command {
  return new Command('lock')
    .description(
      'Compute and pin SHA values for all remote sources in the config',
    )
    .option('--force', 'overwrite existing SHA values')
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { force?: boolean };
      await runLock(!!opts.force, cmd);
    });
}
