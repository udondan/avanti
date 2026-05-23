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
import { evaluateConditions } from '../condition';
import {
  fetchSource,
  FetchCache,
  SourceFetchRecord,
  formatSourceLabel,
} from '../sources';
import { sortByDependencies } from '../dependencies';
import { applyReplace } from '../processors/replace';
import { applyWriteHook, runHook } from '../processors/on';
import { applyInsertMode } from '../processors/insert';
import { isBinary } from '../binary';
import {
  buildNewFileDiff,
  computeDiff,
  computeDeleteDiff,
  FileDiff,
  printDiffs,
} from '../diff';
import {
  atomicWrite,
  getSudoFileMode,
  sudoAtomicWrite,
  sudoAuth,
  sudoDelete,
  sudoFileExists,
  sudoIsSymlink,
  sudoRead,
  sudoRun,
  SudoWriteTarget,
  WriteTarget,
} from '../writer';
import {
  buildEntryPreVars,
  expandTilde,
  resolveFollowSymlink,
  resolveTargetPath,
} from '../paths';
import { AvantiConfig, FileEntry, OnHooks, Variables } from '../types';
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

interface FileHookContext {
  targetPath: string;
  hooks: OnHooks;
  isNew: boolean;
}

interface FetchLoopResult {
  writeTargets: WriteTarget[];
  allDiffs: FileDiff[];
  fileHookContexts: FileHookContext[];
  hasError: boolean;
  shaErrors: ShaError[];
  sourceRecordsByTarget: Map<string, SourceFetchRecord[]>;
  skippedPaths: Set<string>;
  hasUnresolvableSkippedPath: boolean;
  insertedFragments: Map<string, { raw: string; processed: string }>;
  selfContent?: string;
  selfMode?: string;
  selfSudo?: true | string;
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
      fileHookContexts: [],
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
  const fileHookContexts: FileHookContext[] = [];
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
  let selfSudo: true | string | undefined;
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
        fileHookContexts,
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
      fileHookContexts: [],
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
          selfSudo = entry.sudo || undefined;
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
        if (entry.on && diff.hasChanges) {
          fileHookContexts.push({
            targetPath: ep,
            hooks: entry.on,
            isNew: diff.isNew,
          });
        }
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
    fileHookContexts,
    hasError,
    shaErrors,
    sourceRecordsByTarget,
    skippedPaths,
    hasUnresolvableSkippedPath,
    insertedFragments,
    selfContent,
    selfMode,
    selfSudo,
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
      let fileHookContexts = firstPass.fileHookContexts;
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
        let currentSelfSudo = firstPass.selfSudo;
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
          currentSelfSudo = next.selfSudo;
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
            fileHookContexts = second.fileHookContexts;
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
                sudo: currentSelfSudo,
              });
              allDiffs.push(computeDiff(configPath, selfBuf, currentSelfMode));
            } else {
              const resolvedSelfMode =
                currentSelfMode ?? writeTargets[existingIdx].mode;
              writeTargets[existingIdx] = {
                ...writeTargets[existingIdx],
                content: selfBuf,
                mode: resolvedSelfMode,
                // Fall back to the existing target's sudo identity when $self
                // doesn't specify one, so a privileged config file keeps its
                // write privileges after $self stabilization.
                sudo: currentSelfSudo ?? writeTargets[existingIdx].sudo,
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
      // Maps path → sudo identity for stale files that need privileged deletion
      const staleDeleteSudo = new Map<string, true | string>();
      // Maps path → staleDiffs index so we can check hasChanges before auth/write
      const staleDeleteDiffIndex = new Map<string, number>();
      const staleToRestore: WriteTarget[] = [];
      const staleDiffs: FileDiff[] = [];
      // Parallel array: staleDiffs index for each staleToRestore entry
      const staleRestoreDiffIndices: number[] = [];

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
              staleRestoreDiffIndices.push(staleDiffs.length);
              staleDiffs.push(computeDiff(ref.absolutePath, original));
            } else {
              console.warn(
                `Warning: cannot restore original for ${ref.absolutePath} — v0 was never captured (file was unreadable at first pull). Leaving file unchanged.`,
              );
            }
          } else {
            staleToDelete.push(ref.absolutePath);
            if (meta.sudo) staleDeleteSudo.set(ref.absolutePath, meta.sudo);
            staleDeleteDiffIndex.set(ref.absolutePath, staleDiffs.length);
            staleDiffs.push(computeDeleteDiff(ref.absolutePath));
          }
        }
      }

      // Windows does not have sudo; fail before any authentication attempt.
      if (
        process.platform === 'win32' &&
        (writeTargets.some((t) => t.sudo) ||
          staleToRestore.some((t) => t.sudo) ||
          staleDeleteSudo.size > 0)
      ) {
        console.error('sudo is not supported on Windows');
        process.exit(2);
      }

      // Authenticate early for unreadable sudo files so we can read their actual
      // content before deciding whether anything changed. Without this, every pull
      // would show unreadable files as "changed" (we can't diff without reading),
      // and "Nothing to do." could never be reported on a re-run.
      const unreadableSudoValues = new Set<true | string>();
      for (let i = 0; i < writeTargets.length; i++) {
        if (allDiffs[i].isUnreadable && writeTargets[i].sudo) {
          unreadableSudoValues.add(writeTargets[i].sudo!);
        }
      }
      // Also auth for unreadable stale restore targets that need sudo.
      for (let i = 0; i < staleToRestore.length; i++) {
        const diffIdx = staleRestoreDiffIndices[i];
        if (staleDiffs[diffIdx]?.isUnreadable && staleToRestore[i].sudo) {
          unreadableSudoValues.add(staleToRestore[i].sudo!);
        }
      }
      const authenticatedSudoIds = new Set<true | string>();
      for (const sv of unreadableSudoValues) {
        try {
          sudoAuth(sv);
        } catch (err: unknown) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }
        authenticatedSudoIds.add(sv);
      }
      // For entries where lstatSync failed (parent directory not searchable),
      // use sudoFileExists to determine whether the file actually exists so
      // existedBeforeAvanti is recorded correctly. Also compute modeChange now
      // that we have sudo access (computeDiff could not stat the file pre-auth).
      for (let i = 0; i < writeTargets.length; i++) {
        if (allDiffs[i].lstatFailed && writeTargets[i].sudo) {
          const exists = sudoFileExists(
            writeTargets[i].sudo!,
            writeTargets[i].targetPath,
          );
          const isNew = !exists;
          let modeChange = allDiffs[i].modeChange;
          if (exists && writeTargets[i].mode) {
            const curModeStr = getSudoFileMode(
              writeTargets[i].sudo!,
              writeTargets[i].targetPath,
            );
            if (curModeStr !== undefined) {
              const desired = parseInt(writeTargets[i].mode!, 8);
              const cur = parseInt(curModeStr, 8);
              if (!isNaN(desired) && !isNaN(cur) && desired !== cur) {
                modeChange = { from: cur, to: desired };
              }
            }
          }
          if (isNew) {
            // File confirmed absent — rebuild as a proper new-file diff so
            // formatDiff shows the actual content instead of "unreadable".
            allDiffs[i] = buildNewFileDiff(
              allDiffs[i].targetPath,
              writeTargets[i].content,
              modeChange,
            );
            // Clear backupPath: it was set assuming the file existed (conservative
            // lstatFailed default). Since the file is actually new, there is
            // nothing to back up and the backup should not be created.
            writeTargets[i] = { ...writeTargets[i], backupPath: undefined };
          } else {
            allDiffs[i] = { ...allDiffs[i], isNew, modeChange };
          }
          // Propagate corrected isNew to the hook context so lifecycle hooks
          // receive the correct AVANTI_IS_NEW value.
          const hookIdx = fileHookContexts.findIndex(
            (ctx) => ctx.targetPath === writeTargets[i].targetPath,
          );
          if (hookIdx >= 0) {
            fileHookContexts[hookIdx] = { ...fileHookContexts[hookIdx], isNew };
          }
        }
      }
      // Post-auth idempotency: compare current file content via sudo against the
      // desired content. If they match, suppress the write for this entry.
      for (let i = 0; i < writeTargets.length; i++) {
        if (allDiffs[i].isUnreadable && writeTargets[i].sudo) {
          const current = sudoRead(
            writeTargets[i].sudo!,
            writeTargets[i].targetPath,
          );
          if (current !== null && current.equals(writeTargets[i].content)) {
            const updatedHasChanges = allDiffs[i].modeChange !== undefined;
            allDiffs[i] = {
              ...allDiffs[i],
              contentChanged: false,
              hasChanges: updatedHasChanges,
            };
            // Only remove hook context when the diff is a true no-op (no mode
            // change either). A mode-only change still triggers before/afterUpdate
            // hooks, so the context must remain for those cases.
            if (!updatedHasChanges) {
              const hookIdx = fileHookContexts.findIndex(
                (ctx) => ctx.targetPath === writeTargets[i].targetPath,
              );
              if (hookIdx >= 0) {
                fileHookContexts.splice(hookIdx, 1);
              }
            }
          }
        }
      }
      // Same idempotency check for stale restore targets: if the current file
      // content already matches the v0 original, suppress the redundant write.
      for (let i = 0; i < staleToRestore.length; i++) {
        const diffIdx = staleRestoreDiffIndices[i];
        if (staleDiffs[diffIdx]?.isUnreadable && staleToRestore[i].sudo) {
          const current = sudoRead(
            staleToRestore[i].sudo!,
            staleToRestore[i].targetPath,
          );
          if (current !== null && current.equals(staleToRestore[i].content)) {
            staleDiffs[diffIdx] = {
              ...staleDiffs[diffIdx],
              contentChanged: false,
              hasChanges: staleDiffs[diffIdx].modeChange !== undefined,
            };
          }
        }
      }

      const hasChanges =
        allDiffs.some((d) => d.hasChanges) ||
        staleDiffs.some((d) => d.hasChanges) ||
        // A stale restore where the original v0 is empty and the file is
        // missing produces hasChanges=false ('' !== '' = false) but isNew=true.
        // Without this, the early-exit below fires before activeStaleRestore is
        // computed and the file is never recreated.
        staleDiffs.some((d) => d.isNew);
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
        // Even when content is unchanged, the sudo setting on a tracked file
        // may have changed in the config. Persist the updated identity so that
        // future stale cleanup uses the correct privileges.
        if (historyAvailable) {
          for (let i = 0; i < writeTargets.length; i++) {
            if (history.getFileMeta(writeTargets[i].targetPath)) {
              history.updateFileSudo(
                writeTargets[i].targetPath,
                writeTargets[i].sudo,
              );
            }
          }
        }
        // Prune no-op stale refs from the pull log. When all diffs are clean,
        // every stale entry (delete or restore) was already resolved outside of
        // avanti (file manually deleted, or content already matches v0). Without
        // this, those refs remain in the last-pull log and can incorrectly flag
        // a future file at the same path as stale.
        if (
          pullId &&
          historyAvailable &&
          (staleToDelete.length > 0 || staleToRestore.length > 0)
        ) {
          const noopStalePaths = new Set<string>([
            ...staleToDelete,
            ...staleToRestore.map((t) => t.targetPath),
          ]);
          const lastFiles = history.getLastPullFiles();
          const survivingRefs = lastFiles.filter(
            (ref) => !noopStalePaths.has(ref.absolutePath),
          );
          // Refresh sudo on surviving refs: updateFileSudo() already wrote the
          // new value to meta.json, but the refs here snapshot the old pull log.
          // Re-hydrate from writeTargets so closePullSession records the correct
          // identity for future stale cleanup.
          const currentSudoByPath = new Map(
            writeTargets.map((t) => [t.targetPath, t.sudo]),
          );
          const updatedSurvivingRefs = survivingRefs.map((ref) => {
            if (currentSudoByPath.has(ref.absolutePath)) {
              const s = currentSudoByPath.get(ref.absolutePath);
              return { ...ref, sudo: s || undefined };
            }
            return ref;
          });
          history.closePullSession(
            pullId,
            normalizeConfigKey(configPath),
            updatedSurvivingRefs,
          );
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

      for (const ctx of fileHookContexts) {
        const env = {
          AVANTI_TARGET: ctx.targetPath,
          AVANTI_IS_NEW: String(ctx.isNew),
        };
        const runNamedHook = (key: string, script: string): void => {
          try {
            runHook(script, env);
          } catch (err: unknown) {
            console.error(
              `Hook ${key} failed for ${ctx.targetPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(2);
          }
        };
        if (ctx.hooks.beforeWrite)
          runNamedHook('beforeWrite', ctx.hooks.beforeWrite);
        if (ctx.isNew && ctx.hooks.beforeCreate)
          runNamedHook('beforeCreate', ctx.hooks.beforeCreate);
        if (!ctx.isNew && ctx.hooks.beforeUpdate)
          runNamedHook('beforeUpdate', ctx.hooks.beforeUpdate);
      }

      // Compute write batches and authenticate before staging so that sudo is
      // available for v0 capture of unreadable first-seen files (history must
      // record the original content before it is overwritten).
      const changedTargets = writeTargets.filter(
        (_, i) => allDiffs[i].hasChanges && allDiffs[i].contentChanged,
      );
      // Only include stale restore targets whose diff still has changes (not
      // suppressed by the idempotency check above). Also include diffs where
      // isNew is true: a missing file with empty v0 produces hasChanges=false
      // ('' !== '' = false) but still needs to be written.
      const activeStaleRestoreIndices = staleToRestore
        .map((_, i) => i)
        .filter((i) => {
          const d = staleDiffs[staleRestoreDiffIndices[i]];
          return d?.hasChanges || d?.isNew;
        });
      const activeStaleRestore = activeStaleRestoreIndices.map(
        (i) => staleToRestore[i],
      );

      const sudoValues = new Set<true | string>(
        [...changedTargets, ...activeStaleRestore]
          .map((t) => t.sudo)
          .filter(Boolean) as (true | string)[],
      );
      // Only include stale delete sudo identities when the delete diff still
      // has changes (file wasn't already absent at diff time).
      for (const [p, sv] of staleDeleteSudo) {
        const idx = staleDeleteDiffIndex.get(p);
        if (idx !== undefined && staleDiffs[idx].hasChanges) {
          sudoValues.add(sv);
        }
      }
      for (let i = 0; i < writeTargets.length; i++) {
        if (
          allDiffs[i].modeChange &&
          !allDiffs[i].contentChanged &&
          writeTargets[i].sudo
        ) {
          sudoValues.add(writeTargets[i].sudo!);
        }
      }
      // Skip identities already authenticated in the early unreadable-file pass
      // so a single pull session never re-prompts for the same identity.
      for (const sv of sudoValues) {
        if (!authenticatedSudoIds.has(sv)) {
          try {
            sudoAuth(sv);
          } catch (err: unknown) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(2);
          }
          authenticatedSudoIds.add(sv);
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
            // For a first-seen unreadable sudo file, capture v0 via sudo so
            // revert-to-original works even when the invoking user cannot read
            // the file directly.
            let v0Override: Buffer | undefined;
            if (
              allDiffs[i].isUnreadable &&
              !allDiffs[i].isNew &&
              writeTargets[i].sudo &&
              !history.getFileMeta(targetPath)
            ) {
              v0Override =
                sudoRead(writeTargets[i].sudo!, targetPath) ?? undefined;
            }
            const { fileRef } = history.stageFileVersion(
              pullId,
              targetPath,
              writeTargets[i].content,
              allDiffs[i].isNew,
              sourceShaRecords,
              writeTargets[i].sudo,
              v0Override,
            );
            stagedFileRefs.push(fileRef);
          } catch {
            console.warn(
              `Warning: could not record history for ${writeTargets[i].targetPath}`,
            );
          }
        }
      }

      let postWriteError: string | null = null;
      const effectivelyDeleted = new Set<string>();
      const effectivelyRestored = new Set<string>();
      // Tracks all stale paths fully resolved this pull — including no-ops
      // (file already gone, or already matches v0). Used to prune old refs
      // from history so stale cleanup does not repeat on subsequent pulls.
      const effectivelyCleaned = new Set<string>();
      try {
        // changedTargets and sudoValues already computed above; auth already done.

        // Content writes go first so that if atomicWrite throws, no permissions
        // have been changed yet (minimises partial-apply surface).
        const isSudoTarget = (t: WriteTarget): t is SudoWriteTarget => !!t.sudo;
        const regularChanged = changedTargets.filter((t) => !t.sudo);
        const sudoChanged = changedTargets.filter(isSudoTarget);
        // Only restore entries whose diff still has changes (no-op restores filtered out)
        const regularRestore = activeStaleRestore.filter((t) => !t.sudo);
        const sudoRestore = activeStaleRestore.filter(isSudoTarget);
        const regularDelete = staleToDelete.filter(
          (p) => !staleDeleteSudo.has(p),
        );

        atomicWrite([...regularChanged, ...regularRestore]);
        if (sudoChanged.length + sudoRestore.length > 0) {
          sudoAtomicWrite([...sudoChanged, ...sudoRestore]);
        }
        // Mark all active stale restores as completed (atomicWrite throws on
        // failure so if we reach here all restores were written successfully).
        for (const t of activeStaleRestore) {
          effectivelyRestored.add(t.targetPath);
          effectivelyCleaned.add(t.targetPath);
        }
        // No-op stale restores (file already matches v0) are also cleaned —
        // mark them so their refs are removed from history and the cleanup
        // does not repeat on subsequent pulls.
        const activeStaleRestorePaths = new Set(
          activeStaleRestore.map((t) => t.targetPath),
        );
        for (const t of staleToRestore) {
          if (!activeStaleRestorePaths.has(t.targetPath)) {
            effectivelyCleaned.add(t.targetPath);
          }
        }
        // Deletions are deferred until both write batches succeed so that
        // stale files are not removed if a later write batch fails.
        for (const p of regularDelete) {
          const idx = staleDeleteDiffIndex.get(p);
          if (idx === undefined) continue;
          if (!staleDiffs[idx].hasChanges) {
            // File is already gone — no-op, but still clean up its history ref.
            effectivelyCleaned.add(p);
            continue;
          }
          try {
            fs.rmSync(p, { force: true });
            effectivelyDeleted.add(p);
            effectivelyCleaned.add(p);
          } catch (err) {
            console.warn(
              `Warning: could not delete ${p}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        for (const [p, sv] of staleDeleteSudo) {
          const idx = staleDeleteDiffIndex.get(p);
          if (idx === undefined) continue;
          if (!staleDiffs[idx].hasChanges) {
            // File is already gone — no-op, but still clean up its history ref.
            effectivelyCleaned.add(p);
          } else if (sudoDelete(p, sv)) {
            effectivelyDeleted.add(p);
            effectivelyCleaned.add(p);
          }
        }

        // Mode-only changes: apply chmod directly (POSIX only — mode bits are
        // not meaningful on Windows so modeChange is never set there).
        let modeOnlyCount = 0;
        if (process.platform !== 'win32') {
          for (let i = 0; i < writeTargets.length; i++) {
            const d = allDiffs[i];
            if (d.modeChange && !d.contentChanged) {
              if (writeTargets[i].sudo) {
                // Use sudo for the symlink/existence checks: fs.lstatSync
                // throws EACCES on paths inside root-owned directories.
                // Skip chmod if the file has been deleted since diff
                // computation (mirrors non-sudo throwIfNoEntry: false path).
                if (
                  sudoFileExists(
                    writeTargets[i].sudo!,
                    writeTargets[i].targetPath,
                  ) &&
                  !sudoIsSymlink(
                    writeTargets[i].sudo!,
                    writeTargets[i].targetPath,
                  )
                ) {
                  sudoRun(writeTargets[i].sudo!, [
                    'chmod',
                    '--',
                    d.modeChange.to.toString(8).padStart(4, '0'),
                    writeTargets[i].targetPath,
                  ]);
                  modeOnlyCount++;
                }
              } else {
                const lst = fs.lstatSync(writeTargets[i].targetPath, {
                  throwIfNoEntry: false,
                });
                if (lst && !lst.isSymbolicLink()) {
                  fs.chmodSync(writeTargets[i].targetPath, d.modeChange.to);
                  modeOnlyCount++;
                }
              }
            }
          }
        }
        const deletedCount = effectivelyDeleted.size;
        const written =
          changedTargets.length +
          activeStaleRestore.length +
          deletedCount +
          modeOnlyCount;
        console.log(`Wrote ${written} file(s).`);
        for (const ctx of fileHookContexts) {
          if (postWriteError !== null) break;
          const env = {
            AVANTI_TARGET: ctx.targetPath,
            AVANTI_IS_NEW: String(ctx.isNew),
          };
          const runNamedPostHook = (key: string, script: string): void => {
            if (postWriteError !== null) return;
            try {
              runHook(script, env);
            } catch (err: unknown) {
              postWriteError = `Hook ${key} failed for ${ctx.targetPath}: ${err instanceof Error ? err.message : String(err)}`;
            }
          };
          if (ctx.isNew && ctx.hooks.create)
            runNamedPostHook('create', ctx.hooks.create);
          if (!ctx.isNew && ctx.hooks.update)
            runNamedPostHook('update', ctx.hooks.update);
        }
      } catch (err: unknown) {
        console.error(
          `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }

      // For tracked files whose content is unchanged, meta.sudo is not updated
      // by stageFileVersion (which only runs for changed files). Sync the sudo
      // field here so stale cleanup uses the correct privileges if the sudo
      // setting changes without a content change. Deferred until after all
      // writes succeed so that a failed write does not corrupt the stored sudo
      // identity for the last successful pull.
      if (historyAvailable) {
        for (let i = 0; i < writeTargets.length; i++) {
          if (
            !allDiffs[i].contentChanged &&
            history.getFileMeta(writeTargets[i].targetPath)
          ) {
            history.updateFileSudo(
              writeTargets[i].targetPath,
              writeTargets[i].sudo,
            );
          }
        }
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

      // Record to pulls.jsonl when files were staged OR stale files were
      // deleted/restored. For stale-only runs, merge surviving refs from the
      // last pull so the cleaned-up paths are no longer listed — without this,
      // subsequent pulls see the same stale files in the last-pull log and
      // attempt the same delete/restore again on every run.
      if (
        pullId &&
        (stagedFileRefs.length > 0 || effectivelyCleaned.size > 0)
      ) {
        try {
          let refsToRecord = stagedFileRefs;
          if (historyAvailable) {
            const lastFiles = history.getLastPullFiles();
            const survivingRefs = lastFiles.filter(
              (ref) => !effectivelyCleaned.has(ref.absolutePath),
            );
            const stagedPaths = new Set(
              stagedFileRefs.map((r) => r.absolutePath),
            );
            // Refresh the sudo field on surviving refs from the current
            // writeTargets config. Without this, closePullSession writes the
            // old sudo value back to meta.json, overwriting the correct value
            // already set by the updateFileSudo call above.
            const currentSudoByPath = new Map(
              writeTargets.map((t) => [t.targetPath, t.sudo]),
            );
            const updatedSurvivingRefs = survivingRefs.map((ref) => {
              if (currentSudoByPath.has(ref.absolutePath)) {
                const s = currentSudoByPath.get(ref.absolutePath);
                return { ...ref, sudo: s || undefined };
              }
              return ref;
            });
            refsToRecord = [
              ...updatedSurvivingRefs.filter(
                (r) => !stagedPaths.has(r.absolutePath),
              ),
              ...stagedFileRefs,
            ];
          }
          history.closePullSession(
            pullId,
            normalizeConfigKey(configPath),
            refsToRecord,
          );
        } catch {
          console.warn('Warning: could not save pull history.');
        }
      }

      if (postWriteError !== null) {
        console.error(postWriteError);
        process.exit(2);
      }
    });
}
