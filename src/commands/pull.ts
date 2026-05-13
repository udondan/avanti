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
import { evaluateConditions } from '../condition';
import { fetchSource, FetchCache, SourceFetchRecord } from '../sources';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { applyInsertMode } from '../processors/insert';
import { isBinary } from '../binary';
import {
  computeDiff,
  computeDeleteDiff,
  printDiffs,
  resolveTargetPath,
} from '../diff';
import { atomicWrite, WriteTarget } from '../writer';
import { FileDiff } from '../diff';
import { AvantiConfig } from '../types';
import { HistoryManager, PullLogFileRef, SourceShaRecord } from '../history';
import { confirm } from '../prompt';
import { applyUpdatedShas, writeUpdatedShas } from '../config-writeback';
import { resolveVariableSpec } from '../variables-remote';

interface ShaError {
  sourceLabel: string;
  expectedSha: string;
  observedSha: string;
}

interface FetchLoopResult {
  writeTargets: WriteTarget[];
  allDiffs: FileDiff[];
  hasError: boolean;
  shaErrors: ShaError[];
  sourceRecordsByTarget: Map<string, SourceFetchRecord[]>;
  skippedPaths: Set<string>;
  hasUnresolvableSkippedPath: boolean;
  insertedFragments: Map<string, { raw: string; processed: string }>;
  selfContent?: string;
  selfMode?: string;
  selfSourceRecords?: SourceFetchRecord[];
}

async function runFetchLoop(
  config: AvantiConfig,
  workingDir: string,
  cache?: FetchCache,
  configPath?: string,
  history?: HistoryManager,
): Promise<FetchLoopResult> {
  let vars;
  try {
    vars = await resolveVariableSpec(config.variables ?? {}, workingDir, cache);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return {
      writeTargets: [],
      allDiffs: [],
      hasError: true,
      shaErrors: [],
      sourceRecordsByTarget: new Map(),
      skippedPaths: new Set(),
      hasUnresolvableSkippedPath: false,
      insertedFragments: new Map(),
    };
  }
  const writeTargets: WriteTarget[] = [];
  const allDiffs: FileDiff[] = [];
  const shaErrors: ShaError[] = [];
  const seenShaErrorLabels = new Set<string>();
  const sourceRecordsByTarget = new Map<string, SourceFetchRecord[]>();
  const skippedPaths = new Set<string>();
  const insertedFragments = new Map<
    string,
    { raw: string; processed: string }
  >();
  let hasUnresolvableSkippedPath = false;
  let hasError = false;
  let selfContent: string | undefined;
  let selfMode: string | undefined;
  let selfSourceRecords: SourceFetchRecord[] | undefined;

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
      return {
        writeTargets,
        allDiffs,
        hasError: true,
        shaErrors,
        sourceRecordsByTarget,
        skippedPaths,
        hasUnresolvableSkippedPath,
        insertedFragments,
      };
    }
    // $self was condition-skipped: protect configPath from stale cleanup so a
    // previously-written config file is not restored or deleted on this run.
    if (
      !hasSelf &&
      configPath !== undefined &&
      !isRemoteConfigSpec(configPath)
    ) {
      skippedPaths.add(configPath);
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
      ) {
        try {
          skippedPaths.add(resolveTargetPath(entry, '', workingDir, vars));
        } catch {
          console.warn(
            `Warning: skipped entry has an unresolvable target path — stale cleanup disabled for this run.`,
          );
          hasUnresolvableSkippedPath = true;
        }
        continue;
      }
      const result = await fetchSource(
        entry,
        workingDir,
        vars,
        cache,
        isSelf && configPath !== undefined ? () => configPath : undefined,
      );

      if (result.allSkipped && !isSelf) {
        try {
          skippedPaths.add(resolveTargetPath(entry, '', workingDir, vars));
        } catch {
          console.warn(
            `Warning: skipped entry has an unresolvable target path — stale cleanup disabled for this run.`,
          );
          hasUnresolvableSkippedPath = true;
        }
        continue;
      }

      for (const rec of result.sourceRecords) {
        if (!rec.matched && !seenShaErrorLabels.has(rec.sourceLabel)) {
          seenShaErrorLabels.add(rec.sourceLabel);
          shaErrors.push({
            sourceLabel: rec.sourceLabel,
            expectedSha: rec.expectedSha!,
            observedSha: rec.observedSha,
          });
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
          // Processors only operate on text; binary files are passed through unchanged.
          const rawText = content.toString('utf8');
          let text = rawText;
          if (entry.replace?.length)
            text = applyReplace(text, entry.replace, vars);
          if (entry.post) text = applyPost(text, entry.post, vars);
          if (entry.strategy === 'insert' && !isSelf) {
            const targetPath = resolveTargetPath(
              entry,
              relPath,
              workingDir,
              vars,
            );
            const lastInserted =
              history?.getInsertedFragment(targetPath) ?? null;
            const processedText = text;
            text = applyInsertMode(
              entry,
              processedText,
              lastInserted?.processed ?? null,
              targetPath,
            );
            insertedFragments.set(targetPath, {
              raw: rawText,
              processed: processedText,
            });
          }
          content = Buffer.from(text, 'utf8');
        }
        if (isSelf) {
          selfContent = content.toString('utf8');
          selfMode = entry.mode;
          if (result.sourceRecords.length > 0)
            selfSourceRecords = result.sourceRecords;
          continue;
        }
        const targetPath = resolveTargetPath(entry, relPath, workingDir, vars);
        allDiffs.push(computeDiff(targetPath, content));
        writeTargets.push({ targetPath, content, mode: entry.mode });
        if (result.sourceRecords.length > 0) {
          sourceRecordsByTarget.set(targetPath, result.sourceRecords);
        }
      }
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      hasError = true;
    }
  }

  return {
    writeTargets,
    allDiffs,
    hasError,
    shaErrors,
    sourceRecordsByTarget,
    skippedPaths,
    hasUnresolvableSkippedPath,
    insertedFragments,
    selfContent,
    selfMode,
    selfSourceRecords,
  };
}

function printShaErrors(errors: ShaError[]): void {
  for (const e of errors) {
    console.error(
      `SHA mismatch for ${e.sourceLabel}\n` +
        `  expected: ${e.expectedSha}\n` +
        `  got:      ${e.observedSha}`,
    );
  }
}

export function pullCommand(): Command {
  return new Command('pull')
    .description('Pull remote sources and write to local files')
    .option('-y, --yes', 'skip confirmation prompt')
    .option(
      '--accept-changes',
      'accept SHA mismatches, update SHA values in config, and apply changes',
    )
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { yes?: boolean; acceptChanges?: boolean };
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();
      const via = parseVia(
        cmd.parent?.opts().via as string | undefined,
        '--via',
      );

      let config;
      try {
        config = await loadConfig(configPath, via);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      const history = new HistoryManager(
        normalizeConfigKey(configPath),
        workingDir,
      );
      const historyAvailable = history.ensureStorageDir();
      const pullId = historyAvailable ? history.openPullSession() : null;

      const fetchCache: FetchCache = new Map();
      const firstPass = await runFetchLoop(
        config,
        workingDir,
        fetchCache,
        configPath,
        history,
      );
      let { writeTargets, allDiffs, sourceRecordsByTarget } = firstPass;
      let insertedFragments = firstPass.insertedFragments;
      let skippedPaths = firstPass.skippedPaths;
      let hasUnresolvableSkippedPath = firstPass.hasUnresolvableSkippedPath;

      if (firstPass.hasError) {
        console.error('Aborting due to errors.');
        process.exit(2);
      }

      // SHA validation — abort unless --accept-changes
      if (firstPass.shaErrors.length > 0 && !opts.acceptChanges) {
        printShaErrors(firstPass.shaErrors);
        console.error(
          '\nRun `avanti pull --accept-changes` to review the diff and update SHA values.',
        );
        process.exit(2);
      }

      // $self stabilization loop: keep fetching $self until content converges,
      // then fetch all non-$self file entries from the stable config.
      if (firstPass.selfContent !== undefined) {
        let prevSelfContent: string | undefined;
        let currentSelfContent = firstPass.selfContent;
        let currentSelfMode = firstPass.selfMode;
        let currentSelfSourceRecords = firstPass.selfSourceRecords;
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

          // Stable when: merged config has no $self, or fetching $self produced
          // the same content as the previous iteration (fixed point reached).
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
          const next = await runFetchLoop(
            currentConfig,
            workingDir,
            fetchCache,
            configPath,
            history,
          );

          if (next.hasError) {
            console.error(
              'Aborting due to errors in $self re-evaluated config.',
            );
            process.exit(2);
          }
          if (next.shaErrors.length > 0 && !opts.acceptChanges) {
            printShaErrors(next.shaErrors);
            console.error(
              '\nRun `avanti pull --accept-changes` to review the diff and update SHA values.',
            );
            process.exit(2);
          }
          const seenInLoop = new Set(
            firstPass.shaErrors.map((e) => e.sourceLabel),
          );
          for (const e of next.shaErrors) {
            if (!seenInLoop.has(e.sourceLabel)) firstPass.shaErrors.push(e);
          }

          if (next.selfContent === undefined) {
            stableConfig = currentConfig;
            break;
          }

          prevSelfContent = currentSelfContent;
          currentSelfContent = next.selfContent;
          currentSelfMode = next.selfMode;
          currentSelfSourceRecords = next.selfSourceRecords;
        }

        if (stableConfig !== undefined) {
          // Fetch all non-$self entries from the stable config.
          // Use Object.create(null) to preserve the null-prototype invariant
          // established by parseConfigContent and avoid prototype pollution.
          const filesWithoutSelf = Object.create(
            null,
          ) as typeof stableConfig.files;
          for (const [k, v] of Object.entries(stableConfig.files)) {
            if (k !== SELF_KEY) filesWithoutSelf[k] = v;
          }
          if (Object.keys(filesWithoutSelf).length > 0) {
            const second = await runFetchLoop(
              { ...stableConfig, files: filesWithoutSelf },
              workingDir,
              fetchCache,
              configPath,
              history,
            );
            if (second.hasError) {
              console.error('Aborting due to errors.');
              process.exit(2);
            }
            if (second.shaErrors.length > 0 && !opts.acceptChanges) {
              printShaErrors(second.shaErrors);
              console.error(
                '\nRun `avanti pull --accept-changes` to review the diff and update SHA values.',
              );
              process.exit(2);
            }
            writeTargets = second.writeTargets;
            allDiffs = second.allDiffs;
            sourceRecordsByTarget = second.sourceRecordsByTarget;
            insertedFragments = second.insertedFragments;
            skippedPaths = second.skippedPaths;
            if (second.hasUnresolvableSkippedPath)
              hasUnresolvableSkippedPath = true;
            const seenInSecond = new Set(
              firstPass.shaErrors.map((e) => e.sourceLabel),
            );
            for (const e of second.shaErrors) {
              if (!seenInSecond.has(e.sourceLabel)) firstPass.shaErrors.push(e);
            }
          }
          // For local configs, write the stable $self content back to disk.
          // If the stable config also declares a file entry for configPath,
          // replace it with the stabilized $self content so the on-disk config
          // always matches what was actually used for this run.
          if (!isRemoteConfigSpec(configPath)) {
            const selfBuf = Buffer.from(currentSelfContent, 'utf8');
            const existingIdx = writeTargets.findIndex(
              (t) => t.targetPath === configPath,
            );
            if (existingIdx === -1) {
              writeTargets.push({
                targetPath: configPath,
                content: selfBuf,
                mode: currentSelfMode,
              });
              allDiffs.push(computeDiff(configPath, selfBuf));
            } else {
              writeTargets[existingIdx] = {
                ...writeTargets[existingIdx],
                content: selfBuf,
                mode: currentSelfMode ?? writeTargets[existingIdx].mode,
              };
              allDiffs[existingIdx] = computeDiff(configPath, selfBuf);
            }
            // Content comes from $self — attribute the config file write to the
            // $self sources so history reflects the actual origin.
            if (currentSelfSourceRecords !== undefined) {
              sourceRecordsByTarget.set(configPath, currentSelfSourceRecords);
            } else {
              sourceRecordsByTarget.delete(configPath);
            }
          }
        }
      }

      // Detect stale files: present in last pull but no longer in current source fetch
      const staleToDelete: string[] = [];
      const staleToRestore: WriteTarget[] = [];
      const staleDiffs: FileDiff[] = [];

      if (historyAvailable && !hasUnresolvableSkippedPath) {
        const lastFiles = history.getLastPullFiles();
        const currentPaths = new Set(writeTargets.map((t) => t.targetPath));
        const skippedPathsArr = [...skippedPaths];
        for (const ref of lastFiles) {
          if (currentPaths.has(ref.absolutePath)) continue;
          // Files covered by a skipped (condition-gated) entry should not be
          // treated as stale — the entry is still in the config, it just didn't
          // run this time. Exact match for file entries; prefix match for
          // directory entries (whose resolved base path is the directory itself).
          const coveredBySkipped = skippedPathsArr.some(
            (sp) =>
              ref.absolutePath === sp ||
              ref.absolutePath.startsWith(sp + path.sep),
          );
          if (coveredBySkipped) continue;
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

      // Show SHA mismatch summary when using --accept-changes
      if (opts.acceptChanges && firstPass.shaErrors.length > 0) {
        console.error('');
        printShaErrors(firstPass.shaErrors);
      }

      if (!hasChanges && firstPass.shaErrors.length === 0) {
        console.log('Nothing to do.');
        process.exit(0);
      }

      const yes: boolean = opts.yes ?? false;
      if (!yes) {
        const promptMsg =
          opts.acceptChanges && firstPass.shaErrors.length > 0
            ? 'Accept new SHA values and apply changes? [y/N] '
            : 'Apply changes? [y/N] ';
        const ok = await confirm(promptMsg);
        if (!ok) {
          console.log('Aborted.');
          process.exit(0);
        }
      }

      // Warn when --accept-changes is used with a remote config: SHA values
      // cannot be written back, so the mismatch will recur on the next pull.
      if (
        opts.acceptChanges &&
        firstPass.shaErrors.length > 0 &&
        isRemoteConfigSpec(configPath)
      ) {
        console.warn(
          'Warning: config is remote; SHA values cannot be written back. ' +
            'Mismatches accepted for this session only.',
        );
      }

      // Pre-apply SHA updates to the config write target in-memory so that both
      // history and the on-disk file reflect the final pinned state in one pass.
      const shaUpdates =
        opts.acceptChanges &&
        firstPass.shaErrors.length > 0 &&
        !isRemoteConfigSpec(configPath)
          ? new Map(
              firstPass.shaErrors.map((e) => [e.sourceLabel, e.observedSha]),
            )
          : null;
      let configShaPreApplied = false;
      if (shaUpdates !== null) {
        const configTargetIdx = writeTargets.findIndex(
          (t) => t.targetPath === configPath,
        );
        if (configTargetIdx !== -1) {
          const patched = applyUpdatedShas(
            writeTargets[configTargetIdx].content.toString('utf8'),
            shaUpdates,
          );
          if (patched !== null) {
            const patchedBuf = Buffer.from(patched, 'utf8');
            writeTargets[configTargetIdx] = {
              ...writeTargets[configTargetIdx],
              content: patchedBuf,
            };
            // Recompute diff so staging and atomicWrite both see SHA-patched content,
            // even when the original content diff was empty.
            allDiffs[configTargetIdx] = computeDiff(
              writeTargets[configTargetIdx].targetPath,
              patchedBuf,
            );
            configShaPreApplied = true;
          }
        }
      }

      // Stage history versions before atomicWrite so v0 is captured before overwrite
      const stagedFileRefs: PullLogFileRef[] = [];
      if (pullId) {
        const acceptedShaLabels = new Set(
          firstPass.shaErrors.map((e) => e.sourceLabel),
        );
        for (let i = 0; i < writeTargets.length; i++) {
          const targetPath = writeTargets[i].targetPath;
          const records = sourceRecordsByTarget.get(targetPath);
          const hasAcceptedSha =
            opts.acceptChanges &&
            records?.some(
              (r) => !r.matched && acceptedShaLabels.has(r.sourceLabel),
            );
          if (!allDiffs[i].hasChanges && !hasAcceptedSha) continue;
          try {
            const sourceShaRecords: SourceShaRecord[] | undefined =
              records !== undefined
                ? records.map((r) => ({
                    label: r.sourceLabel,
                    observedSha: r.observedSha,
                    expectedSha: r.expectedSha,
                    accepted:
                      !r.matched &&
                      (opts.acceptChanges ?? false) &&
                      acceptedShaLabels.has(r.sourceLabel),
                  }))
                : undefined;
            const { fileRef } = history.stageFileVersion(
              pullId,
              targetPath,
              writeTargets[i].content,
              allDiffs[i].isNew,
              sourceShaRecords,
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
        const changedTargets = writeTargets.filter(
          (_, i) => allDiffs[i].hasChanges,
        );
        atomicWrite([...changedTargets, ...staleToRestore], staleToDelete);
        const written =
          changedTargets.length + staleToRestore.length + staleToDelete.length;
        console.log(`Wrote ${written} file(s).`);
      } catch (err: unknown) {
        console.error(
          `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }

      // Save inserted fragments to history for future idempotency detection
      if (historyAvailable && insertedFragments.size > 0) {
        for (const [targetPath, fragment] of insertedFragments) {
          history.saveInsertedFragment(
            targetPath,
            fragment.raw,
            fragment.processed,
          );
        }
      }

      // SHA writeback: write updated sha values into config file after all writes complete.
      // Skipped when config was a write target and already patched in-memory above.
      if (shaUpdates !== null && !configShaPreApplied) {
        try {
          const pinned = writeUpdatedShas(configPath, shaUpdates);
          if (pinned)
            console.log(`Updated ${shaUpdates.size} SHA pin(s) in config.`);
        } catch (err: unknown) {
          console.warn(
            `Warning: could not update SHA values in config: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Only record to pulls.jsonl if at least one file was staged (written or
      // SHA-accepted via --accept-changes with no content diff)
      if (pullId && stagedFileRefs.length > 0) {
        try {
          history.closePullSession(
            pullId,
            normalizeConfigKey(configPath),
            stagedFileRefs,
          );
        } catch {
          console.warn('Warning: could not save pull history.');
        }
      }
    });
}
