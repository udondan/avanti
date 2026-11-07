import { Command } from 'commander';
import * as path from 'path';
import { normalizeConfigKey, resolveConfigPath } from '../config';
import { expandTilde } from '../paths';
import { HistoryManager } from '../history';

/** Resolves the global `--working-dir` option, defaulting to the cwd. */
export function resolveWorkingDir(cmd: Command): string {
  const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
  return rawWorkingDir
    ? path.resolve(expandTilde(rawWorkingDir))
    : process.cwd();
}

/** Opens the history of the project selected by `--config`/`--working-dir`. */
export function openProjectHistory(cmd: Command): HistoryManager {
  const configPath = resolveConfigPath(
    cmd.parent?.opts().config as string | undefined,
  );
  const workingDir = resolveWorkingDir(cmd);
  return new HistoryManager(normalizeConfigKey(configPath), workingDir);
}
