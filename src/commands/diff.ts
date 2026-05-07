import { Command } from 'commander';
import * as path from 'path';
import { loadConfig, resolveConfigPath } from '../config';
import { fetchSource } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { computeDiff, printDiffs, resolveTargetPath } from '../diff';
import { FileDiff } from '../diff';

export function diffCommand(): Command {
  return new Command('diff')
    .description('Show diff between remote sources and local files')
    .action(async (_options: unknown, cmd: Command) => {
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();

      let config;
      try {
        config = loadConfig(configPath);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(2);
      }
      const allDiffs: FileDiff[] = [];
      let hasError = false;

      const vars = config.variables ?? {};

      for (const entry of config.files) {
        try {
          const result = await fetchSource(entry, workingDir, vars);
          for (const [relPath, rawContent] of result.files) {
            let content = rawContent;
            if (entry.replace?.length)
              content = applyReplace(content, entry.replace, vars);
            if (entry.post) content = applyPost(content, entry.post, vars);
            const targetPath = resolveTargetPath(
              entry,
              relPath,
              workingDir,
              vars,
            );
            allDiffs.push(computeDiff(targetPath, content));
          }
        } catch (err: unknown) {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: ${(err as Error).message}`,
          );
          hasError = true;
        }
      }

      printDiffs(allDiffs);

      const hasChanges = allDiffs.some((d) => d.hasChanges);
      if (hasError) process.exit(2);
      process.exit(hasChanges ? 1 : 0);
    });
}
