import { Command } from 'commander';
import * as path from 'path';
import {
  isRemoteConfigSpec,
  loadConfig,
  normalizeConfigKey,
  parseConfigContent,
  resolveConfigPath,
  SELF_KEY,
} from '../config';
import { fetchSource } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import {
  computeDiff,
  computeDeleteDiff,
  printDiffs,
  resolveTargetPath,
} from '../diff';
import { FileDiff } from '../diff';
import { AvantiConfig } from '../types';
import { HistoryManager } from '../history';

interface DiffLoopResult {
  allDiffs: FileDiff[];
  hasError: boolean;
  selfContent?: string;
}

async function runDiffLoop(
  config: AvantiConfig,
  workingDir: string,
): Promise<DiffLoopResult> {
  const vars = config.variables ?? {};
  const allDiffs: FileDiff[] = [];
  let hasError = false;
  let selfContent: string | undefined;

  for (const [key, entry] of Object.entries(config.files)) {
    const isSelf = key === SELF_KEY;
    try {
      const result = await fetchSource(entry, workingDir, vars);
      for (const rec of result.sourceRecords) {
        if (!rec.matched) {
          console.error(
            `⚠  SHA mismatch for ${rec.sourceLabel}\n` +
              `   expected: ${rec.expectedSha}\n` +
              `   got:      ${rec.observedSha}`,
          );
        }
      }
      for (const [relPath, rawContent] of result.files) {
        let content = rawContent;
        if (entry.replace?.length)
          content = applyReplace(content, entry.replace, vars);
        if (entry.post) content = applyPost(content, entry.post, vars);
        if (isSelf) {
          selfContent = content;
          continue;
        }
        const targetPath = resolveTargetPath(entry, relPath, workingDir, vars);
        allDiffs.push(computeDiff(targetPath, content));
      }
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${(err as Error).message}`,
      );
      hasError = true;
    }
  }

  return { allDiffs, hasError, selfContent };
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
        const configPath = resolveConfigPath(
          cmd.parent?.opts().config as string | undefined,
        );
        const rawWorkingDir = cmd.parent?.opts().workingDir as
          | string
          | undefined;
        const workingDir = rawWorkingDir
          ? path.resolve(rawWorkingDir)
          : process.cwd();

        if (pullId !== undefined) {
          diffAgainstHistory(
            pullId,
            normalizeConfigKey(configPath),
            workingDir,
          );
          return;
        }

        let config;
        try {
          config = await loadConfig(configPath);
        } catch (err: unknown) {
          console.error((err as Error).message);
          process.exit(2);
        }

        const firstPass = await runDiffLoop(config, workingDir);
        let { allDiffs, hasError } = firstPass;

        if (hasError) process.exit(2);

        if (firstPass.selfContent !== undefined) {
          try {
            const newConfig = parseConfigContent(firstPass.selfContent);
            console.log(
              '$self config resolved; re-evaluating with merged config...',
            );
            const second = await runDiffLoop(newConfig, workingDir);
            allDiffs = second.allDiffs;
            hasError = second.hasError;
            if (
              !isRemoteConfigSpec(configPath) &&
              !allDiffs.some((d) => d.targetPath === configPath)
            ) {
              allDiffs.push(computeDiff(configPath, firstPass.selfContent));
            }
          } catch (err: unknown) {
            console.warn(
              `Warning: $self config is invalid, skipping re-evaluation: ${(err as Error).message}`,
            );
          }
        }

        printDiffs(allDiffs);

        const hasChanges = allDiffs.some((d) => d.hasChanges);
        if (hasError) process.exit(2);
        process.exit(hasChanges ? 1 : 0);
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
  for (const [absolutePath, { version }] of snapshot) {
    const historicalContent = history.readVersion(absolutePath, version);
    if (historicalContent === null) continue;
    diffs.push(computeDiff(absolutePath, historicalContent));
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
