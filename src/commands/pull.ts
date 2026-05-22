import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
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
import {
  fetchSource,
  FetchCache,
  SourceFetchRecord,
  formatSourceLabel,
} from '../sources';
import { sortByDependencies } from '../dependencies';
import { applyReplace } from '../processors/replace';
import { applyPost } from '../processors/post';
import { applyInsertMode } from '../processors/insert';
import { isBinary } from '../binary';
import { computeDiff, computeDeleteDiff, printDiffs } from '../diff';
import {
  atomicWrite,
  sudoAtomicWrite,
  sudoAuth,
  sudoUserArgs,
  WriteTarget,
} from '../writer';
import { FileDiff } from '../diff';
import {
  buildEntryPreVars,
  expandTilde,
  resolveFollowSymlink,
  resolveTargetPath,
} from '../paths';
import { AvantiConfig, FileEntry, Variables } from '../types';
import { HistoryManager, PullLogFileRef, SourceShaRecord } from '../history';
import { confirm } from '../prompt';
import { applyUpdatedShas, writeUpdatedShas } from '../config-writeback';
import { resolveVariableSpec } from '../variables-remote';
import {
  buildDateVars,
  buildFileVars,
  buildSystemVars,
  resolveBackupPath,
  resolveVars,
} from '../variables';

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
  dateVars: Variables,
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
  if (configPath !== undefined) {
    vars['self'] = configPath;
  }
  Object.assign(vars, dateVars);
  Object.assign(vars, buildSystemVars());
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
  const pendingWrites = new Map<string, Buffer>();
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
  const nonSelfEntries = Object.entries(config.files).filter(
    ([k]) => k !== SELF_KEY,
  );
  let sortedEntries: [string, FileEntry][];
  try {
    sortedEntries = sortByDependencies(nonSelfEntries, workingDir, vars);
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
      ) {
        let symlinkPath: string;
        try {
          symlinkPath = resolveTargetPath(entry, '', workingDir, vars);
        } catch {
          console.warn(
            `Warning: skipped entry has an unresolvable target path — stale cleanup disabled for this run.`,
          );
          hasUnresolvableSkippedPath = true;
          continue;
        }
        skippedPaths.add(symlinkPath);
        // Also skip the resolved real path so stale cleanup doesn't treat
        // the symlink target as unmanaged when followSymlink is in use.
        // Skip for directory targets — resolveFollowSymlink throws on dir symlinks.
        // resolveFollowSymlink security errors (escape/directory/cycle) are
        // intentionally NOT caught here — they propagate as hard failures.
        const resolvedTarget0 = entry.target
          ? resolveVars(entry.target, vars)
          : '';
        if (
          !resolvedTarget0.endsWith('/') &&
          !resolvedTarget0.endsWith(path.sep)
        ) {
          const realPath = resolveFollowSymlink(symlinkPath, entry, workingDir);
          if (realPath !== symlinkPath) skippedPaths.add(realPath);
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

      if (result.allSkipped && !isSelf) {
        let symlinkPath2: string;
        try {
          symlinkPath2 = resolveTargetPath(entry, '', workingDir, vars);
        } catch {
          console.warn(
            `Warning: skipped entry has an unresolvable target path — stale cleanup disabled for this run.`,
          );
          hasUnresolvableSkippedPath = true;
          continue;
        }
        skippedPaths.add(symlinkPath2);
        // resolveFollowSymlink security errors propagate as hard failures.
        const resolvedTarget2 = entry.target
          ? resolveVars(entry.target, vars)
          : '';
        if (
          !resolvedTarget2.endsWith('/') &&
          !resolvedTarget2.endsWith(path.sep)
        ) {
          const realPath = resolveFollowSymlink(
            symlinkPath2,
            entry,
            workingDir,
          );
          if (realPath !== symlinkPath2) skippedPaths.add(realPath);
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

      const applyTemplate =
        entry.template !== undefined
          ? (await import('../processors/template')).applyTemplate
          : undefined;
      for (const [relPath, rawContent] of result.files) {
        // Compute the target path early so per-file vars ($path, $filename,
        // $basename, $ext, $dirname, $basedir) are available in processors.
        // For $self the path resolution would fail (config path is absolute),
        // so we skip it and fall back to the base vars.
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
        // Resolve any symlink on the target path early so insert-mode tracking
        // and all subsequent operations use the real file path consistently.
        const effectivePath =
          targetPath !== undefined
            ? resolveFollowSymlink(targetPath, entry, workingDir)
            : undefined;

        let content = rawContent;
        if (!isBinary(content)) {
          // Processors only operate on text; binary files are passed through unchanged.
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
          if (entry.post) text = applyPost(text, entry.post, entryVars);
          if (entry.strategy === 'insert' && !isSelf) {
            const lastInserted =
              history?.getInsertedFragment(effectivePath!) ?? null;
            if (
              lastInserted !== null &&
              rawText === lastInserted.raw &&
              text === lastInserted.processed &&
              fs.existsSync(effectivePath!)
            ) {
              skippedPaths.add(targetPath!); // keep stale detection from treating this as missing
              if (effectivePath !== targetPath!)
                skippedPaths.add(effectivePath!);
              continue; // source and processed output unchanged — skip write entirely (no-op)
            }
            const processedText = text;
            text = applyInsertMode(
              entry,
              processedText,
              lastInserted?.processed ?? null,
              effectivePath!,
            );
            insertedFragments.set(effectivePath!, {
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
        // effectivePath is always defined here: isSelf is false (we continued above),
        // so targetPath was defined, and effectivePath = resolveFollowSymlink(targetPath, ...).
        const ep = effectivePath!;
        const diff = computeDiff(ep, content, entry.mode);
        allDiffs.push(diff);
        const backupPath =
          entry.backup && diff.hasChanges && !diff.isNew
            ? resolveBackupPath(
                entry.backup,
                ep,
                workingDir,
                vars,
                config.backup_roots ?? [],
              )
            : undefined;
        writeTargets.push({
          targetPath: ep,
          content,
          mode: entry.mode,
          backupPath,
          writeInPlace: entry.writeInPlace,
          sudo: entry.sudo,
        });
        pendingWrites.set(ep, content);
        // Also index under the original symlink path so local source lookups
        // using the symlink path (not the resolved real path) still find the
        // pending content within the same fetch loop.
        if (ep !== targetPath!) {
          pendingWrites.set(targetPath!, content);
          // Mark the symlink path as covered so stale detection doesn't treat
          // a previously-tracked symlink path as stale when followSymlink is
          // enabled on an entry that was first pulled without it.
          skippedPaths.add(targetPath!);
        }
        if (result.sourceRecords.length > 0) {
          sourceRecordsByTarget.set(ep, result.sourceRecords);
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
      `SHA mismatch for ${formatSourceLabel(e.sourceLabel)}\n` +
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
        ? path.resolve(expandTilde(rawWorkingDir))
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
      const dateVars = buildDateVars();
      const firstPass = await runFetchLoop(
        config,
        workingDir,
        dateVars,
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
            dateVars,
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
              dateVars,
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
              allDiffs.push(computeDiff(configPath, selfBuf, currentSelfMode));
            } else {
              const resolvedSelfMode =
                currentSelfMode ?? writeTargets[existingIdx].mode;
              writeTargets[existingIdx] = {
                ...writeTargets[existingIdx],
                content: selfBuf,
                mode: resolvedSelfMode,
              };
              allDiffs[existingIdx] = computeDiff(
                configPath,
                selfBuf,
                resolvedSelfMode,
              );
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
      const staleDeleteNeedsSudo = new Set<string>();
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
                sudo: meta.sudo,
              });
              staleDiffs.push(computeDiff(ref.absolutePath, original));
            }
          } else {
            staleToDelete.push(ref.absolutePath);
            if (meta.sudo) staleDeleteNeedsSudo.add(ref.absolutePath);
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
        if (historyAvailable && insertedFragments.size > 0) {
          for (const [targetPath, fragment] of insertedFragments) {
            history.saveInsertedFragment(
              targetPath,
              fragment.raw,
              fragment.processed,
            );
          }
        }
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
              writeTargets[i].sudo,
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
          (_, i) => allDiffs[i].hasChanges && allDiffs[i].contentChanged,
        );

        // Authenticate sudo once before any writes if any target needs it.
        const allWriteTargets = [...changedTargets, ...staleToRestore];
        const sudoValues = new Set<boolean | string>(
          allWriteTargets.map((t) => t.sudo).filter(Boolean) as (
            | boolean
            | string
          )[],
        );
        if (staleDeleteNeedsSudo.size > 0) {
          sudoValues.add(true);
        }
        for (const sv of sudoValues) {
          sudoAuth(sv);
        }

        // Content writes go first so that if atomicWrite throws, no permissions
        // have been changed yet (minimises partial-apply surface).
        const regularChanged = changedTargets.filter((t) => !t.sudo);
        const sudoChanged = changedTargets.filter((t) => t.sudo);
        const regularRestore = staleToRestore.filter((t) => !t.sudo);
        const sudoRestore = staleToRestore.filter((t) => t.sudo);
        const regularDelete = staleToDelete.filter(
          (p) => !staleDeleteNeedsSudo.has(p),
        );
        const sudoDelete = staleToDelete.filter((p) =>
          staleDeleteNeedsSudo.has(p),
        );

        atomicWrite([...regularChanged, ...regularRestore], regularDelete);
        if (sudoChanged.length + sudoRestore.length + sudoDelete.length > 0) {
          sudoAtomicWrite([...sudoChanged, ...sudoRestore], sudoDelete);
        }

        // Mode-only changes: apply chmod directly (POSIX only — mode bits are
        // not meaningful on Windows so modeChange is never set there).
        let modeOnlyCount = 0;
        if (process.platform !== 'win32') {
          for (let i = 0; i < writeTargets.length; i++) {
            const d = allDiffs[i];
            if (d.modeChange && !d.contentChanged) {
              const lst = fs.lstatSync(writeTargets[i].targetPath, {
                throwIfNoEntry: false,
              });
              if (lst && !lst.isSymbolicLink()) {
                if (writeTargets[i].sudo) {
                  spawnSync(
                    'sudo',
                    [
                      ...sudoUserArgs(writeTargets[i].sudo!),
                      'chmod',
                      d.modeChange.to.toString(8).padStart(4, '0'),
                      writeTargets[i].targetPath,
                    ],
                    { stdio: 'inherit' },
                  );
                } else {
                  fs.chmodSync(writeTargets[i].targetPath, d.modeChange.to);
                }
                modeOnlyCount++;
              }
            }
          }
        }
        const written =
          changedTargets.length +
          staleToRestore.length +
          staleToDelete.length +
          modeOnlyCount;
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
