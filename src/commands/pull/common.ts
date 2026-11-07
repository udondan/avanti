/**
 * Helpers shared by the pull, diff and lock commands: CLI option resolution,
 * base variable setup and the `$self` / dependency-ordered entry plan.
 */
import { Command } from 'commander';
import * as path from 'path';
import { SELF_KEY } from '../../config';
import { evaluateConditions } from '../../condition';
import { FetchCache } from '../../sources';
import { sortByDependencies } from '../../dependencies';
import { expandTilde } from '../../paths';
import { AvantiConfig, FileEntry, Variables } from '../../types';
import { HistoryManager } from '../../history';
import { resolveVariablesAndEnvironment } from '../../context';
import { buildSystemVars } from '../../variables';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveWorkingDir(cmd: Command): string {
  const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
  return rawWorkingDir
    ? path.resolve(expandTilde(rawWorkingDir))
    : process.cwd();
}

/** Shared inputs of one fetch pass over the config's file entries. */
export interface LoopContext {
  workingDir: string;
  dateVars: Variables;
  cache: FetchCache;
  configPath: string;
  history: HistoryManager;
  configBase: string;
}

export function applyBaseVars(
  vars: Variables,
  configPath: string,
  dateVars: Variables,
  workingDir: string,
): void {
  vars['self'] = configPath;
  Object.assign(vars, dateVars);
  Object.assign(vars, buildSystemVars());
  vars['workingDir'] = workingDir;
  vars['cwd'] = workingDir;
}

/** Resolves config variables/environment; prints the error and returns undefined on failure. */
export async function resolveLoopVars(
  config: AvantiConfig,
  ctx: LoopContext,
): Promise<Variables | undefined> {
  let vars: Variables;
  try {
    ({ vars } = await resolveVariablesAndEnvironment(
      config.variables ?? {},
      config.environment ?? {},
      ctx.workingDir,
      ctx.cache,
      ctx.configBase,
    ));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return undefined;
  }
  applyBaseVars(vars, ctx.configPath, ctx.dateVars, ctx.workingDir);
  return vars;
}

interface EntryPlan {
  /** True when `$self` is declared but its condition evaluated to false. */
  selfSkipped: boolean;
  entries: [string, FileEntry][];
}

/**
 * Decides which entries a pass processes: only `$self` when it is present and
 * its condition holds, otherwise all other entries in dependency order.
 * Prints the error and returns undefined on failure.
 */
export function planEntries(
  config: AvantiConfig,
  ctx: LoopContext,
  vars: Variables,
): EntryPlan | undefined {
  const selfDeclared = SELF_KEY in config.files;
  let hasSelf = selfDeclared;
  if (selfDeclared) {
    const selfEntry = config.files[SELF_KEY];
    try {
      hasSelf = evaluateConditions(
        selfEntry['if'],
        selfEntry.ifAny,
        () => ctx.configPath,
        ctx.workingDir,
        vars,
      );
    } catch (err: unknown) {
      console.error(`Error processing ${SELF_KEY}: ${errorMessage(err)}`);
      return undefined;
    }
  }
  const nonSelfEntries = Object.entries(config.files).filter(
    ([k]) => k !== SELF_KEY,
  );
  let sortedEntries: [string, FileEntry][];
  try {
    sortedEntries = sortByDependencies(nonSelfEntries, ctx.workingDir, vars);
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return undefined;
  }
  return {
    selfSkipped: selfDeclared && !hasSelf,
    entries: hasSelf ? [[SELF_KEY, config.files[SELF_KEY]]] : sortedEntries,
  };
}

/** Copy of the config's files without `$self`, keeping the null prototype. */
export function filesWithoutSelf(config: AvantiConfig): AvantiConfig['files'] {
  // Use Object.create(null) to preserve the null-prototype invariant
  // established by parseConfigContent and avoid prototype pollution.
  const files = Object.create(null) as AvantiConfig['files'];
  for (const [k, v] of Object.entries(config.files)) {
    if (k !== SELF_KEY) files[k] = v;
  }
  return files;
}
