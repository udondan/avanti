import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from '../config';
import { fetchSource } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { computeDiff, printDiffs, resolveTargetPath } from '../diff';
import { FileDiff } from '../diff';

export function diffCommand(): Command {
  return new Command('diff')
    .description('Show diff between remote sources and local files')
    .action(async (_options, cmd) => {
      const configPath = path.resolve(
        cmd.parent?.opts().config ?? 'avanti.yml',
      );
      let config;
      try {
        config = loadConfig(configPath);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(2);
      }

      const baseDir = path.dirname(configPath);
      const allDiffs: FileDiff[] = [];
      let hasError = false;

      for (const entry of config.files) {
        try {
          const result = await fetchSource(entry);
          for (const [relPath, rawContent] of result.files) {
            let content = rawContent;
            if (entry.replace?.length)
              content = applyReplace(content, entry.replace);
            if (entry.post) content = applyPost(content, entry.post);
            const targetPath = resolveTargetPath(entry, relPath, baseDir);
            allDiffs.push(computeDiff(targetPath, content));
          }
        } catch (err: unknown) {
          console.error(
            `Error processing ${entry.src}: ${(err as Error).message}`,
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
