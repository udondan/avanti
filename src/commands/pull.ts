import { Command } from 'commander';
import * as path from 'path';
import { loadConfig, resolveConfigPath } from '../config';
import { fetchSource } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import {
  computeDiff,
  computeDeleteDiff,
  printDiffs,
  resolveTargetPath,
} from '../diff';
import { atomicWrite, WriteTarget } from '../writer';
import { FileDiff } from '../diff';
import { HistoryManager, PullLogFileRef } from '../history';
import { confirm } from '../prompt';

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

      const history = new HistoryManager(configPath, workingDir);
      const historyAvailable = history.ensureStorageDir();
      const pullId = historyAvailable ? history.openPullSession() : null;

      const allDiffs: FileDiff[] = [];
      const writeTargets: WriteTarget[] = [];
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

      // Detect stale files: present in last pull but no longer in current source fetch
      const staleToDelete: string[] = [];
      const staleToRestore: WriteTarget[] = [];
      const staleDiffs: FileDiff[] = [];

      if (historyAvailable) {
        const lastFiles = history.getLastPullFiles();
        const currentPaths = new Set(writeTargets.map((t) => t.targetPath));
        for (const ref of lastFiles) {
          if (currentPaths.has(ref.absolutePath)) continue;
          const meta = history.getFileMeta(ref.absolutePath);
          if (!meta) continue;
          if (meta.existedBeforeAvanti) {
            const original = history.readVersion(ref.absolutePath, 0);
            if (original !== null) {
              staleToRestore.push({
                targetPath: ref.absolutePath,
                content: original,
              });
              staleDiffs.push(computeDiff(ref.absolutePath, original));
            }
          } else {
            staleToDelete.push(ref.absolutePath);
            staleDiffs.push(computeDeleteDiff(ref.absolutePath));
          }
        }
      }

      const hasChanges =
        allDiffs.some((d) => d.hasChanges) ||
        staleDiffs.some((d) => d.hasChanges);
      printDiffs([...allDiffs, ...staleDiffs]);

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

      // Stage history versions before atomicWrite so v0 is captured before overwrite
      const stagedFileRefs: PullLogFileRef[] = [];
      if (pullId) {
        for (let i = 0; i < writeTargets.length; i++) {
          if (!allDiffs[i].hasChanges) continue;
          try {
            const { fileRef } = history.stageFileVersion(
              pullId,
              writeTargets[i].targetPath,
              writeTargets[i].content,
              allDiffs[i].isNew,
            );
            stagedFileRefs.push(fileRef);
          } catch {
            console.warn(
              `Warning: could not record history for ${writeTargets[i].targetPath}`,
            );
          }
        }
      }

      try {
        atomicWrite([...writeTargets, ...staleToRestore], staleToDelete);
        const written =
          writeTargets.filter((_, i) => allDiffs[i].hasChanges).length +
          staleToRestore.length +
          staleToDelete.length;
        console.log(`Wrote ${written} file(s).`);
      } catch (err: unknown) {
        console.error(`Write failed: ${(err as Error).message}`);
        process.exit(2);
      }

      // Only record to pulls.jsonl if at least one file was actually written
      if (pullId && stagedFileRefs.length > 0) {
        try {
          history.closePullSession(pullId, configPath, stagedFileRefs);
        } catch {
          console.warn('Warning: could not save pull history.');
        }
      }
    });
}
