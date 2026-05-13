import { Command } from 'commander';
import * as path from 'path';
import {
  isRemoteConfigSpec,
  loadConfig,
  resolveConfigPath,
  SELF_KEY,
} from '../config';
import { evaluateConditions } from '../condition';
import { fetchSource } from '../sources';
import { resolveTargetPath } from '../diff';
import { writeUpdatedShas } from '../config-writeback';
import { resolveVariableSpec } from '../variables-remote';

export function lockCommand(): Command {
  return new Command('lock')
    .description(
      'Compute and pin SHA values for all remote sources in the config',
    )
    .option('--force', 'overwrite existing SHA values')
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { force?: boolean };
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();

      if (isRemoteConfigSpec(configPath)) {
        console.error('avanti lock requires a local config file.');
        process.exit(2);
      }

      let config;
      try {
        config = await loadConfig(configPath);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      let vars;
      try {
        vars = await resolveVariableSpec(config.variables ?? {}, workingDir);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
      const toPin = new Map<string, string>(); // label → sha
      let hasError = false;
      let remoteSourceCount = 0;

      for (const [key, entry] of Object.entries(config.files)) {
        try {
          if (
            !evaluateConditions(
              entry['if'],
              entry.ifAny,
              () =>
                key === SELF_KEY
                  ? configPath
                  : resolveTargetPath(entry, '', workingDir, vars),
              workingDir,
              vars,
            )
          )
            continue;
          const result = await fetchSource(entry, workingDir, vars);
          remoteSourceCount += result.sourceRecords.length;
          for (const rec of result.sourceRecords) {
            if (!opts.force && rec.expectedSha !== undefined) continue;
            toPin.set(rec.sourceLabel, rec.observedSha);
          }
        } catch (err: unknown) {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: ${err instanceof Error ? err.message : String(err)}`,
          );
          hasError = true;
        }
      }

      if (toPin.size === 0) {
        if (hasError) process.exit(2);
        if (remoteSourceCount === 0) {
          console.log('No SHA-pinnable remote sources found in config.');
        } else {
          console.log(
            'All remote sources already have SHA values pinned. Use --force to overwrite.',
          );
        }
        process.exit(0);
      }

      if (hasError) {
        console.error(
          'Aborting: one or more sources failed to fetch. No changes written.',
        );
        process.exit(2);
      }

      const pinned = writeUpdatedShas(configPath, toPin);

      if (pinned) {
        for (const [label, sha] of toPin) {
          console.log(`  pinned  ${label}  ${sha.slice(0, 16)}`);
        }
        console.log(`\nPinned ${toPin.size} source(s).`);
      } else {
        console.log('All SHA values are already up to date.');
      }

      process.exit(0);
    });
}
