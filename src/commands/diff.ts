import { Command } from 'commander';
import * as fs from 'fs';
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
import { fetchSource, FetchCache, formatSourceLabel } from '../sources';
import { sortByDependencies } from '../dependencies';
import { applyReplace } from '../processors/replace';
import { applyWriteHook } from '../processors/on';
import { applyInsertMode } from '../processors/insert';
import { isBinary } from '../binary';
import {
  computeDiff,
  computeDeleteDiff,
  computeSymlinkDiff,
  printDiffs,
} from '../diff';
import { FileDiff } from '../diff';
import {
  buildEntryPreVars,
  expandTilde,
  resolveFollowSymlink,
  resolveTargetPath,
} from '../paths';
import { AvantiConfig, FileEntry, LocalSrc, Variables } from '../types';
import { resolveSymlinkSrcPath } from '../sources/local';
import { HistoryManager } from '../history';
import { resolveVariableSpec } from '../variables-remote';
import { evaluateConditions } from '../condition';
import { buildDateVars, buildFileVars, buildSystemVars } from '../variables';

interface DiffLoopResult {
  allDiffs: FileDiff[];
  hasError: boolean;
  selfContent?: string;
  selfMode?: string;
}

async function runDiffLoop(
  config: AvantiConfig,
  workingDir: string,
  dateVars: Variables,
  cache?: FetchCache,
  configPath?: string,
  history?: HistoryManager,
): Promise<DiffLoopResult> {
  let vars;
  try {
    vars = await resolveVariableSpec(config.variables ?? {}, workingDir, cache);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return { allDiffs: [], hasError: true };
  }
  if (configPath !== undefined) {
    vars['self'] = configPath;
  }
  Object.assign(vars, dateVars);
  Object.assign(vars, buildSystemVars());
  const allDiffs: FileDiff[] = [];
  const pendingWrites = new Map<string, Buffer>();
  let hasError = false;
  let selfContent: string | undefined;
  let selfMode: string | undefined;

  let hasSelf = SELF_KEY in config.files;
  if (hasSelf) {
    const selfEntry = config.files[SELF_KEY];
    try {
      hasSelf = evaluateConditions(
        selfEntry['if'],
        selfEntry.ifAny,
        () =>
          configPath !== undefined
            ? configPath
            : resolveTargetPath(selfEntry, '', workingDir, vars),
        workingDir,
        vars,
      );
    } catch (err: unknown) {
      console.error(
        `Error processing ${SELF_KEY}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { allDiffs: [], hasError: true };
    }
  }
  const nonSelfEntries = Object.entries(config.files).filter(
    ([k]) => k !== SELF_KEY,
  );
  let sortedEntries: [string, FileEntry][];
  try {
    sortedEntries = sortByDependencies(nonSelfEntries, workingDir, vars);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return { allDiffs: [], hasError: true };
  }
  const entriesToProcess: [string, FileEntry][] = hasSelf
    ? [[SELF_KEY, config.files[SELF_KEY]], ...sortedEntries]
    : sortedEntries;

  for (const [key, entry] of entriesToProcess) {
    const isSelf = key === SELF_KEY;
    if (hasSelf !== isSelf) continue;
    try {
      const preVars = buildEntryPreVars(entry, isSelf, workingDir, vars);
      if (
        !isSelf &&
        !evaluateConditions(
          entry['if'],
          entry.ifAny,
          () => resolveTargetPath(entry, '', workingDir, vars),
          workingDir,
          preVars,
        )
      )
        continue;

      if (!isSelf && entry.symlink) {
        const targetPath = resolveTargetPath(entry, '', workingDir, vars);
        const rawSrc = Array.isArray(entry.src)
          ? ''
          : typeof entry.src === 'string'
            ? entry.src
            : (entry.src as LocalSrc).path;

        // Honor optional: true — skip when the local source does not exist.
        const isOptionalSrc =
          !Array.isArray(entry.src) &&
          typeof entry.src !== 'string' &&
          !!(entry.src as LocalSrc).optional;
        if (isOptionalSrc) {
          const absSrc = resolveSymlinkSrcPath(
            rawSrc,
            workingDir,
            preVars,
            true,
            targetPath,
          );
          if (!fs.existsSync(absSrc)) continue;
        }

        const symlinkTarget = resolveSymlinkSrcPath(
          rawSrc,
          workingDir,
          preVars,
          entry.symlink,
          targetPath,
        );
        allDiffs.push(computeSymlinkDiff(targetPath, symlinkTarget));
        // Register the resolved src content (not the symlink target string) in
        // pendingWrites so subsequent local entries that read through this symlink
        // path see the actual file bytes, not the raw symlink target path.
        const absSymlinkSrc = resolveSymlinkSrcPath(
          rawSrc,
          workingDir,
          preVars,
          true,
          targetPath,
        );
        try {
          const srcStat = fs.statSync(absSymlinkSrc, { throwIfNoEntry: false });
          if (srcStat?.isFile()) {
            pendingWrites.set(targetPath, fs.readFileSync(absSymlinkSrc));
          }
        } catch {
          // src not readable — omit from pendingWrites
        }
        continue;
      }

      const result = await fetchSource(
        entry,
        workingDir,
        preVars,
        cache,
        isSelf && configPath !== undefined ? () => configPath : undefined,
        pendingWrites,
      );
      for (const rec of result.sourceRecords) {
        if (!rec.matched) {
          console.error(
            `⚠  SHA mismatch for ${formatSourceLabel(rec.sourceLabel)}\n` +
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

      const applyTemplate =
        entry.template !== undefined
          ? (await import('../processors/template')).applyTemplate
          : undefined;
      for (const [relPath, rawContent] of result.files) {
        const targetPath = isSelf
          ? undefined
          : resolveTargetPath(entry, relPath, workingDir, vars);
        const entryVars =
          targetPath !== undefined
            ? Object.assign(
                Object.create(null) as typeof vars,
                vars,
                buildFileVars(targetPath),
              )
            : vars;
        // Resolve any symlink early so insert-mode tracking and all subsequent
        // operations use the real file path consistently.
        const effectivePath =
          targetPath !== undefined
            ? resolveFollowSymlink(targetPath, entry, workingDir)
            : undefined;

        let content = rawContent;
        if (!isBinary(content)) {
          const rawText = content.toString('utf8');
          let text = rawText;
          if (applyTemplate !== undefined) {
            text = await applyTemplate(
              text,
              entry.template!,
              entryVars,
              relPath || undefined,
            );
          }
          if (entry.replace?.length)
            text = applyReplace(text, entry.replace, entryVars);
          if (entry.on?.write)
            text = applyWriteHook(text, entry.on.write, entryVars);
          if (entry.strategy === 'insert' && !isSelf) {
            const lastInserted =
              history?.getInsertedFragment(effectivePath!) ?? null;
            if (
              lastInserted !== null &&
              rawText === lastInserted.raw &&
              text === lastInserted.processed &&
              fs.existsSync(effectivePath!)
            ) {
              continue; // source and processed output unchanged — would be a no-op write, skip diff
            }
            text = applyInsertMode(
              entry,
              text,
              lastInserted?.processed ?? null,
              effectivePath!,
            );
          }
          content = Buffer.from(text, 'utf8');
        }
        if (isSelf) {
          selfContent = content.toString('utf8');
          selfMode = entry.mode;
          continue;
        }
        // effectivePath is always defined here: isSelf is false (we continued above).
        const ep = effectivePath!;
        allDiffs.push(computeDiff(ep, content, entry.mode));
        pendingWrites.set(ep, content);
        // Also index under the original symlink path so local source lookups
        // using the symlink path (not the resolved real path) still find the
        // pending content within the same diff loop.
        if (ep !== targetPath!) pendingWrites.set(targetPath!, content);
      }
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      hasError = true;
    }
  }

  return { allDiffs, hasError, selfContent, selfMode };
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
          ? path.resolve(expandTilde(rawWorkingDir))
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
        const dateVars = buildDateVars();
        const history = new HistoryManager(
          normalizeConfigKey(configPath),
          workingDir,
        );
        const firstPass = await runDiffLoop(
          config,
          workingDir,
          dateVars,
          fetchCache,
          configPath,
          history,
        );
        let { allDiffs, hasError } = firstPass;

        if (hasError) process.exit(2);

        if (firstPass.selfContent !== undefined) {
          let prevSelfContent: string | undefined;
          let currentSelfContent = firstPass.selfContent;
          let currentSelfMode = firstPass.selfMode;
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
              dateVars,
              fetchCache,
              configPath,
              history,
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
            currentSelfMode = next.selfMode;
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
                dateVars,
                fetchCache,
                configPath,
                history,
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
                allDiffs.push(
                  computeDiff(configPath, selfBuf, currentSelfMode),
                );
              } else {
                allDiffs[existingIdx] = computeDiff(
                  configPath,
                  selfBuf,
                  currentSelfMode,
                );
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
  for (const [absolutePath, { version, isSymlink }] of snapshot) {
    const historicalContent = history.readVersion(absolutePath, version);
    if (historicalContent === null) continue;
    if (isSymlink) {
      diffs.push(
        computeSymlinkDiff(absolutePath, historicalContent.toString('utf8')),
      );
    } else {
      diffs.push(computeDiff(absolutePath, historicalContent));
    }
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
