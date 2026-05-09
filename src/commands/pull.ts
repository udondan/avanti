import { Command } from 'commander';
import * as path from 'path';
import {
  isRemoteConfigSpec,
  loadConfig,
  normalizeConfigKey,
  parseConfigContent,
  resolveConfigPath,
} from '../config';
import { fetchSource, SourceFetchRecord } from '../sources';
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
import { AvantiConfig } from '../types';
import { HistoryManager, PullLogFileRef, SourceShaRecord } from '../history';
import { confirm } from '../prompt';
import { applyUpdatedShas, writeUpdatedShas } from '../config-writeback';

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
}

async function runFetchLoop(
  config: AvantiConfig,
  workingDir: string,
): Promise<FetchLoopResult> {
  const vars = config.variables ?? {};
  const writeTargets: WriteTarget[] = [];
  const allDiffs: FileDiff[] = [];
  const shaErrors: ShaError[] = [];
  const sourceRecordsByTarget = new Map<string, SourceFetchRecord[]>();
  let hasError = false;

  for (const entry of config.files) {
    try {
      const result = await fetchSource(entry, workingDir, vars);

      for (const rec of result.sourceRecords) {
        if (!rec.matched) {
          shaErrors.push({
            sourceLabel: rec.sourceLabel,
            expectedSha: rec.expectedSha!,
            observedSha: rec.observedSha,
          });
        }
      }

      for (const [relPath, rawContent] of result.files) {
        let content = rawContent;
        if (entry.replace?.length)
          content = applyReplace(content, entry.replace, vars);
        if (entry.post) content = applyPost(content, entry.post, vars);
        const targetPath = resolveTargetPath(entry, relPath, workingDir, vars);
        allDiffs.push(computeDiff(targetPath, content));
        writeTargets.push({ targetPath, content, mode: entry.mode });
        if (result.sourceRecords.length > 0) {
          sourceRecordsByTarget.set(targetPath, result.sourceRecords);
        }
      }
    } catch (err: unknown) {
      console.error(
        `Error processing ${JSON.stringify(entry.src)}: ${(err as Error).message}`,
      );
      hasError = true;
    }
  }

  return { writeTargets, allDiffs, hasError, shaErrors, sourceRecordsByTarget };
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

      let config;
      try {
        config = await loadConfig(configPath);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(2);
      }

      const history = new HistoryManager(
        normalizeConfigKey(configPath),
        workingDir,
      );
      const historyAvailable = history.ensureStorageDir();
      const pullId = historyAvailable ? history.openPullSession() : null;

      const firstPass = await runFetchLoop(config, workingDir);
      let { writeTargets, allDiffs, sourceRecordsByTarget } = firstPass;

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

      // Detect self-config update: only applies to local config files
      if (!isRemoteConfigSpec(configPath)) {
        const configIdx = writeTargets.findIndex(
          (t) => t.targetPath === configPath,
        );
        if (configIdx !== -1 && allDiffs[configIdx].hasChanges) {
          const newConfigContent = writeTargets[configIdx].content;
          try {
            const newConfig = parseConfigContent(newConfigContent);
            console.log('Config updated; re-evaluating with new config...');
            const second = await runFetchLoop(newConfig, workingDir);
            if (second.hasError) {
              console.error('Aborting due to errors in re-evaluated config.');
              process.exit(2);
            }
            if (second.shaErrors.length > 0 && !opts.acceptChanges) {
              printShaErrors(second.shaErrors);
              console.error(
                '\nRun `avanti pull --accept-changes` to review the diff and update SHA values.',
              );
              process.exit(2);
            }
            const configInSecond = second.writeTargets.findIndex(
              (t) => t.targetPath === configPath,
            );
            if (configInSecond === -1) {
              second.writeTargets.push(writeTargets[configIdx]);
              second.allDiffs.push(allDiffs[configIdx]);
              const firstPassRecords = sourceRecordsByTarget.get(configPath);
              if (firstPassRecords) {
                second.sourceRecordsByTarget.set(configPath, firstPassRecords);
              }
            }
            writeTargets = second.writeTargets;
            allDiffs = second.allDiffs;
            sourceRecordsByTarget = second.sourceRecordsByTarget;
            const existingLabels = new Set(
              firstPass.shaErrors.map((e) => e.sourceLabel),
            );
            for (const e of second.shaErrors) {
              if (!existingLabels.has(e.sourceLabel))
                firstPass.shaErrors.push(e);
            }
          } catch (err: unknown) {
            console.warn(
              `Warning: updated config is invalid, skipping re-evaluation: ${(err as Error).message}`,
            );
          }
        }
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
        // Only pre-apply when the config target has content changes and will be
        // written by atomicWrite anyway; SHA-only updates fall through to
        // writeUpdatedShas so that unchanged targets are never touched.
        if (configTargetIdx !== -1 && allDiffs[configTargetIdx].hasChanges) {
          const patched = applyUpdatedShas(
            writeTargets[configTargetIdx].content,
            shaUpdates,
          );
          if (patched !== null) {
            writeTargets[configTargetIdx] = {
              ...writeTargets[configTargetIdx],
              content: patched,
            };
          }
          configShaPreApplied = true;
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
        console.error(`Write failed: ${(err as Error).message}`);
        process.exit(2);
      }

      // SHA writeback: write updated sha values into config file after all writes complete.
      // Skipped when config was a write target and already patched in-memory above.
      if (shaUpdates !== null && !configShaPreApplied) {
        try {
          writeUpdatedShas(configPath, shaUpdates);
        } catch (err: unknown) {
          console.warn(
            `Warning: could not update SHA values in config: ${(err as Error).message}`,
          );
        }
      }

      // Only record to pulls.jsonl if at least one file was actually written
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
