import { Command } from 'commander';
import * as path from 'path';
import * as readline from 'readline';
import { loadConfig, resolveConfigPath } from '../config';
import { fetchSource } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { computeDiff, printDiffs, resolveTargetPath } from '../diff';
import { atomicWrite, WriteTarget } from '../writer';
import { FileDiff } from '../diff';

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(
        answer.trim().toLowerCase() === 'y' ||
          answer.trim().toLowerCase() === 'yes',
      );
    });
  });
}

export function pullCommand(): Command {
  return new Command('pull')
    .description('Pull remote sources and write to local files')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (options: unknown, cmd: Command) => {
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
      const writeTargets: WriteTarget[] = [];
      let hasError = false;

      for (const entry of config.files) {
        try {
          const result = await fetchSource(entry, workingDir);
          for (const [relPath, rawContent] of result.files) {
            let content = rawContent;
            if (entry.replace?.length)
              content = applyReplace(content, entry.replace);
            if (entry.post) content = applyPost(content, entry.post);
            const targetPath = resolveTargetPath(entry, relPath, workingDir);
            allDiffs.push(computeDiff(targetPath, content));
            writeTargets.push({ targetPath, content, mode: entry.mode });
          }
        } catch (err: unknown) {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: ${(err as Error).message}`,
          );
          hasError = true;
        }
      }

      if (hasError) {
        console.error('Aborting due to errors.');
        process.exit(2);
      }

      const hasChanges = allDiffs.some((d) => d.hasChanges);
      printDiffs(allDiffs);

      if (!hasChanges) {
        console.log('Nothing to do.');
        process.exit(0);
      }

      const yes: boolean = (options as { yes?: boolean }).yes ?? false;
      if (!yes) {
        const ok = await confirm('Apply changes? [y/N] ');
        if (!ok) {
          console.log('Aborted.');
          process.exit(0);
        }
      }

      try {
        atomicWrite(writeTargets);
        console.log(`Wrote ${writeTargets.length} file(s).`);
      } catch (err: unknown) {
        console.error(`Write failed: ${(err as Error).message}`);
        process.exit(2);
      }
    });
}
