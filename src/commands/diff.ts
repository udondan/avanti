import { Command } from 'commander';
import * as path from 'path';
import {
  isRemoteConfigSpec,
  loadConfig,
  normalizeConfigKey,
  parseConfigContent,
  parseVia,
  resolveConfigPath,
  SELF_KEY,
} from '../config';
import { fetchSource, FetchCache } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { isBinary } from '../binary';
import {
  computeDiff,
  computeDeleteDiff,
  printDiffs,
  resolveTargetPath,
} from '../diff';
import { FileDiff } from '../diff';
import { AvantiConfig } from '../types';
import { HistoryManager } from '../history';
import { resolveVariableSpec } from '../variables-remote';
import { evaluateConditions } from '../condition';

interface DiffLoopResult {
  allDiffs: FileDiff[];
  hasError: boolean;
  selfContent?: string;
}

async function runDiffLoop(
  config: AvantiConfig,
  workingDir: string,
  cache?: FetchCache,
): Promise<DiffLoopResult> {
  let vars;
  try {
    vars = await resolveVariableSpec(config.variables ?? {}, workingDir, cache);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return { allDiffs: [], hasError: true };
  }
  const allDiffs: FileDiff[] = [];
  let hasError = false;
  let selfContent: string | undefined;

  let hasSelf = SELF_KEY in config.files;
  if (hasSelf) {
    const selfEntry = config.files[SELF_KEY];
    try {
      hasSelf = evaluateConditions(
        selfEntry['if'],
        selfEntry.ifAny,
        () => resolveTargetPath(selfEntry, '', workingDir, vars),
        workingDir,
        vars,
      );
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(selfEntry.src)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { allDiffs: [], hasError: true };
    }
  }
  for (const [key, entry] of Object.entries(config.files)) {
    const isSelf = key === SELF_KEY;
    if (hasSelf !== isSelf) continue;
    try {
      if (
        !isSelf &&
        !evaluateConditions(
          entry['if'],
          entry.ifAny,
          () => resolveTargetPath(entry, '', workingDir, vars),
          workingDir,
          vars,
        )
      )
        continue;
      const result = await fetchSource(entry, workingDir, vars, cache);
      for (const rec of result.sourceRecords) {
        if (!rec.matched) {
          console.error(
            `⚠  SHA mismatch for ${rec.sourceLabel}\n` +
              `   expected: ${rec.expectedSha}\n` +
              `   got:      ${rec.observedSha}`,
          );
        }
      }
      if (isSelf && result.files.size !== 1) {
        throw new Error(
          `$self must resolve to exactly one file, got ${result.files.size}. Use yaml: true or json: true to merge multiple sources into one.`,
        );
      }

      for (const [relPath, rawContent] of result.files) {
        let content = rawContent;
        if (!isBinary(content)) {
          let text = content.toString('utf8');
          if (entry.replace?.length)
            text = applyReplace(text, entry.replace, vars);
          if (entry.post) text = applyPost(text, entry.post, vars);
          content = Buffer.from(text, 'utf8');
        }
        if (isSelf) {
          selfContent = content.toString('utf8');
          continue;
        }
        const targetPath = resolveTargetPath(entry, relPath, workingDir, vars);
        allDiffs.push(computeDiff(targetPath, content));
      }
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${err instanceof Error ? err.message : String(err)}`,
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
        const via = parseVia(
          cmd.parent?.opts().via as string | undefined,
          '--via',
        );

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
          config = await loadConfig(configPath, via);
        } catch (err: unknown) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }

        const fetchCache: FetchCache = new Map();
        const firstPass = await runDiffLoop(config, workingDir, fetchCache);
        let { allDiffs, hasError } = firstPass;

        if (hasError) process.exit(2);

        if (firstPass.selfContent !== undefined) {
          let prevSelfContent: string | undefined;
          let currentSelfContent = firstPass.selfContent;
          let stableConfig: AvantiConfig | undefined;

          while (stableConfig === undefined) {
            let currentConfig: AvantiConfig;
            try {
              currentConfig = parseConfigContent(currentSelfContent);
            } catch (err: unknown) {
              console.error(
                `$self config is invalid: ${err instanceof Error ? err.message : String(err)}`,
              );
              process.exit(2);
            }

            if (
              !(SELF_KEY in currentConfig.files) ||
              currentSelfContent === prevSelfContent
            ) {
              stableConfig = currentConfig;
              break;
            }

            console.log(
              '$self config resolved; re-evaluating with merged config...',
            );
            const next = await runDiffLoop(
              currentConfig,
              workingDir,
              fetchCache,
            );

            if (next.hasError) {
              hasError = true;
              break;
            }

            if (next.selfContent === undefined) {
              stableConfig = currentConfig;
              break;
            }

            prevSelfContent = currentSelfContent;
            currentSelfContent = next.selfContent;
          }

          if (stableConfig !== undefined) {
            // Use Object.create(null) to preserve the null-prototype invariant
            // established by parseConfigContent and avoid prototype pollution.
            const filesWithoutSelf = Object.create(
              null,
            ) as typeof stableConfig.files;
            for (const [k, v] of Object.entries(stableConfig.files)) {
              if (k !== SELF_KEY) filesWithoutSelf[k] = v;
            }
            if (Object.keys(filesWithoutSelf).length > 0) {
              const second = await runDiffLoop(
                { ...stableConfig, files: filesWithoutSelf },
                workingDir,
                fetchCache,
              );
              allDiffs = second.allDiffs;
              hasError = second.hasError;
            }
            if (!isRemoteConfigSpec(configPath)) {
              const existingIdx = allDiffs.findIndex(
                (d) => d.targetPath === configPath,
              );
              const selfBuf = Buffer.from(currentSelfContent, 'utf8');
              if (existingIdx === -1) {
                allDiffs.push(computeDiff(configPath, selfBuf));
              } else {
                allDiffs[existingIdx] = computeDiff(configPath, selfBuf);
              }
            }
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
