import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import type { WriteOp, WorkerResult } from '../privileged-worker';
import {
  deriveConfigBase,
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
  buildNewSymlinkDiff,
  computeDiff,
  computeDeleteDiff,
  computeSymlinkDiff,
  FileDiff,
  printDiffs,
} from '../diff';
import {
  atomicWrite,
  getSudoFileMode,
  sudoAtomicDelete,
  sudoAtomicRead,
  sudoAtomicWrite,
  sudoFileExists,
  sudoIsDirectory,
  sudoIsSymlink,
  SudoChmodTarget,
  SudoWorkerSession,
  SudoWriteTarget,
  WriteTarget,
} from '../writer';
import {
  buildEntryPreVars,
  expandTilde,
  resolveFollowSymlink,
  resolveTargetPath,
} from '../paths';
import {
  AvantiConfig,
  FileEntry,
  LocalSrc,
  OnHooks,
  Variables,
} from '../types';
import { resolveSymlinkSrcPath } from '../sources/local';
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
  configBase?: string,
): Promise<FetchLoopResult> {
  let vars;
  try {
    vars = await resolveVariableSpec(
      config.variables ?? {},
      workingDir,
      cache,
      configBase,
    );
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

      // Symlink entries: resolve src path and create a symlink instead of
      // fetching and writing file content.
      if (!isSelf && entry.symlink) {
        if (process.platform === 'win32') {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: symlink entries are not supported on Windows; use an \`if: { os: [linux, mac] }\` condition to gate symlink entries in cross-platform configs`,
          );
          hasError = true;
          continue;
        }
        const targetPath = resolveTargetPath(entry, '', workingDir, vars);
        if (Array.isArray(entry.src)) {
          throw new Error(
            `files["${entry.target}"].symlink: src must be a single local path, not an array`,
          );
        }
        const rawSrc =
          typeof entry.src === 'string'
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
          if (!fs.existsSync(absSrc)) {
            // Mark the target as skipped so stale cleanup does not treat a
            // previously-managed path as unmanaged and delete/restore it.
            skippedPaths.add(targetPath);
            continue;
          }
        }

        const symlinkTarget = resolveSymlinkSrcPath(
          rawSrc,
          workingDir,
          preVars,
          entry.symlink,
          targetPath,
        );
        const diff = computeSymlinkDiff(targetPath, symlinkTarget);
        // Symlinks cannot replace existing directories — error early so the
        // write batch is not attempted and EISDIR is not thrown at rename time.
        // Do not push to allDiffs here: allDiffs and writeTargets are parallel
        // arrays; pushing diff without a matching writeTargets entry would
        // misalign subsequent index-based lookups.
        if (diff.isDirectory) {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: symlink: ${targetPath} is a directory; cannot replace with a symlink`,
          );
          hasError = true;
          continue;
        }
        allDiffs.push(diff);
        const symlinkContent = Buffer.from(symlinkTarget, 'utf8');
        const symlinkBackupPath =
          entry.backup && diff.hasChanges && !diff.isNew
            ? resolveBackupPath(
                entry.backup,
                targetPath,
                workingDir,
                vars,
                config.backup_roots ?? [],
              )
            : undefined;
        writeTargets.push({
          targetPath,
          content: symlinkContent,
          symlinkTarget,
          backupPath: symlinkBackupPath,
          sudo: entry.sudo,
        });
        if (entry.on && diff.hasChanges) {
          fileHookContexts.push({
            targetPath,
            hooks: entry.on,
            isNew: diff.isNew,
          });
        }
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
        configBase,
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
      const configBase = deriveConfigBase(configPath);
      const firstPass = await runFetchLoop(
        config,
        workingDir,
        dateVars,
        fetchCache,
        configPath,
        history,
        configBase,
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
            configBase,
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
              configBase,
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
      let staleHasError = false;

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
              if (meta.v0IsSymlink) {
                if (process.platform === 'win32') {
                  console.error(
                    `symlink: ${ref.absolutePath}: cannot restore pre-avanti symlink on Windows`,
                  );
                  staleHasError = true;
                  // Show the actual stored target so the user knows what cannot
                  // be restored. No staleRestoreDiffIndices push — there is no
                  // corresponding staleToRestore entry for error-only diffs.
                  const symlinkTarget = original.toString('utf8');
                  const warnDiff = buildNewSymlinkDiff(
                    ref.absolutePath,
                    symlinkTarget,
                  );
                  staleDiffs.push({ ...warnDiff, hasChanges: true });
                } else {
                  const symlinkTarget = original.toString('utf8');
                  const staleDiff = computeSymlinkDiff(
                    ref.absolutePath,
                    symlinkTarget,
                  );
                  if (staleDiff.isDirectory) {
                    console.error(
                      `symlink: ${ref.absolutePath} is a directory; cannot restore symlink over directory`,
                    );
                    staleHasError = true;
                    // No staleRestoreDiffIndices push — no corresponding
                    // staleToRestore entry for this error-only diff.
                    staleDiffs.push(staleDiff);
                  } else if (staleDiff.hasChanges) {
                    staleToRestore.push({
                      targetPath: ref.absolutePath,
                      content: original,
                      symlinkTarget,
                      sudo: meta.sudo,
                    });
                    staleRestoreDiffIndices.push(staleDiffs.length);
                    staleDiffs.push(staleDiff);
                  }
                }
              } else {
                staleToRestore.push({
                  targetPath: ref.absolutePath,
                  content: original,
                  sudo: meta.sudo,
                });
                staleRestoreDiffIndices.push(staleDiffs.length);
                const staleDiff = computeDiff(ref.absolutePath, original);
                // A missing file with empty v0 produces isNew=true but
                // hasChanges=false and an empty patch, so formatDiff returns ''.
                // Rebuild as a proper new-file diff so the confirmation output
                // shows the recreate action and the patch is consistent.
                staleDiffs.push(
                  staleDiff.isNew
                    ? buildNewFileDiff(ref.absolutePath, original)
                    : staleDiff,
                );
              }
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
            // File confirmed absent — rebuild as a proper new diff so
            // formatDiff shows the actual content instead of "unreadable".
            // Clear backupPath: it was set assuming the file existed (conservative
            // lstatFailed default). Since the file is actually new, there is
            // nothing to back up and the backup should not be created.
            if (writeTargets[i].symlinkTarget !== undefined) {
              // Symlink entry — use buildNewSymlinkDiff instead of
              // computeSymlinkDiff: the parent dir is still not searchable
              // (EACCES), so calling computeSymlinkDiff would lstatSync-fail
              // again and return isUnreadable rather than isNew:true.
              allDiffs[i] = buildNewSymlinkDiff(
                allDiffs[i].targetPath,
                writeTargets[i].symlinkTarget!,
              );
            } else {
              allDiffs[i] = buildNewFileDiff(
                allDiffs[i].targetPath,
                writeTargets[i].content,
                modeChange,
              );
            }
            writeTargets[i] = { ...writeTargets[i], backupPath: undefined };
          } else {
            let updatedDiff: FileDiff = { ...allDiffs[i], isNew, modeChange };
            // For symlink entries, check whether the existing path is a real
            // directory — ln -sf would place the symlink inside it rather than
            // replacing it, so detect this now and surface an error before the
            // write batch is attempted.
            if (writeTargets[i].symlinkTarget !== undefined) {
              const isSymlinkAtTarget = sudoIsSymlink(
                writeTargets[i].sudo!,
                writeTargets[i].targetPath,
              );
              if (
                !isSymlinkAtTarget &&
                sudoIsDirectory(
                  writeTargets[i].sudo!,
                  writeTargets[i].targetPath,
                )
              ) {
                updatedDiff = { ...updatedDiff, isDirectory: true };
              }
            }
            allDiffs[i] = updatedDiff;
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
      // Fail fast if any symlink write target is a real directory: ln -sf would
      // place the symlink inside it rather than replacing it, so abort before
      // prompting the user rather than failing mid-write-batch.
      for (const d of allDiffs) {
        if (d.isDirectory && d.isSymlink) {
          console.error(
            `symlink: ${d.targetPath} is a directory; cannot replace with a symlink`,
          );
        }
      }
      if (allDiffs.some((d) => d.isDirectory && d.isSymlink)) {
        process.exit(2);
      }
      // Create one persistent sudo worker session per distinct sudo identity.
      // Sessions are split into two phases so the password prompt does not
      // appear before the user has seen or accepted the diff:
      //
      //  Phase 1 (early, before pre-reads): only identities with unreadable
      //    targets that need a stat-read for idempotency / v0 capture.
      //  Phase 2 (deferred, after confirmation): identities that only have
      //    readable changed targets or delete-only targets.
      const sudoSessions = new Map<true | string, SudoWorkerSession>();
      if (process.platform !== 'win32') {
        const earlyIds = new Set<true | string>();
        for (let i = 0; i < writeTargets.length; i++) {
          const t = writeTargets[i];
          if (t.sudo && allDiffs[i].isUnreadable) {
            earlyIds.add(t.sudo);
          }
        }
        for (let i = 0; i < staleToRestore.length; i++) {
          const t = staleToRestore[i];
          if (t.sudo) {
            const diffIdx = staleRestoreDiffIndices[i];
            if (staleDiffs[diffIdx]?.isUnreadable) {
              earlyIds.add(t.sudo);
            }
          }
        }
        try {
          for (const id of earlyIds)
            sudoSessions.set(id, new SudoWorkerSession(id));
        } catch (err) {
          for (const session of sudoSessions.values()) session.close();
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }
      }

      // Batch all pre-write reads for unreadable sudo targets into one
      // worker exec per identity using stat-read ops. A stat-read returns
      // the file content (regular files) or the link target (symlinks) and
      // signals isSymlink so callers can branch without a separate sudo call.
      const preReadRequests: Array<{
        filePath: string;
        sudo: true | string;
        type: 'stat-read';
      }> = [];
      for (let i = 0; i < writeTargets.length; i++) {
        if (allDiffs[i].isUnreadable && writeTargets[i].sudo) {
          preReadRequests.push({
            filePath: writeTargets[i].targetPath,
            sudo: writeTargets[i].sudo!,
            type: 'stat-read',
          });
        }
      }
      for (let i = 0; i < staleToRestore.length; i++) {
        const diffIdx = staleRestoreDiffIndices[i];
        if (staleDiffs[diffIdx]?.isUnreadable && staleToRestore[i].sudo) {
          preReadRequests.push({
            filePath: staleToRestore[i].targetPath,
            sudo: staleToRestore[i].sudo!,
            type: 'stat-read',
          });
        }
      }
      let preReads: Map<
        string,
        { contentB64: string; isSymlink?: boolean } | null
      >;
      if (preReadRequests.length > 0) {
        try {
          preReads = await sudoAtomicRead(preReadRequests, sudoSessions);
        } catch (err) {
          for (const session of sudoSessions.values()) session.close();
          console.error(
            `Read failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(2);
        }
      } else {
        preReads = new Map<
          string,
          { contentB64: string; isSymlink?: boolean } | null
        >();
      }

      // Post-auth idempotency: compare current file content via sudo against the
      // desired content. If they match, suppress the write for this entry.
      for (let i = 0; i < writeTargets.length; i++) {
        if (allDiffs[i].isUnreadable && writeTargets[i].sudo) {
          const preRead = preReads.get(writeTargets[i].targetPath);
          if (preRead === null || preRead === undefined) continue;

          if (writeTargets[i].symlinkTarget !== undefined) {
            // Symlink entry: stat-read returns the link target when existing
            // path is a symlink. If it matches the desired target, no-op.
            if (
              preRead.isSymlink &&
              Buffer.from(preRead.contentB64, 'base64').toString() ===
                writeTargets[i].symlinkTarget
            ) {
              const updatedHasChanges = allDiffs[i].modeChange !== undefined;
              allDiffs[i] = {
                ...allDiffs[i],
                contentChanged: false,
                hasChanges: updatedHasChanges,
              };
              if (!updatedHasChanges) {
                const hookIdx = fileHookContexts.findIndex(
                  (ctx) => ctx.targetPath === writeTargets[i].targetPath,
                );
                if (hookIdx >= 0) {
                  fileHookContexts.splice(hookIdx, 1);
                }
              }
            }
            continue;
          }
          // For regular file entries: stat-read signals isSymlink=true when the
          // existing path is a symlink — skip comparison to avoid reading through
          // the symlink rather than the symlink itself.
          if (preRead.isSymlink) continue;

          const current = Buffer.from(preRead.contentB64, 'base64');
          if (current.equals(writeTargets[i].content)) {
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
      // Same idempotency check for stale restore targets.
      for (let i = 0; i < staleToRestore.length; i++) {
        const diffIdx = staleRestoreDiffIndices[i];
        if (staleDiffs[diffIdx]?.isUnreadable && staleToRestore[i].sudo) {
          const preRead = preReads.get(staleToRestore[i].targetPath);
          if (preRead === null || preRead === undefined) continue;
          // Skip comparison when existing path is a symlink.
          if (preRead.isSymlink) continue;
          const current = Buffer.from(preRead.contentB64, 'base64');
          if (current.equals(staleToRestore[i].content)) {
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
        staleDiffs.some((d) => d.hasChanges);
      printDiffs([...allDiffs, ...staleDiffs]);

      if (staleHasError) process.exit(2);

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
          // Preserve existing sudo on surviving refs — no file was written, so
          // the on-disk ownership reflects the previous write identity, not the
          // current config. Overwriting here would let stale cleanup run with
          // the wrong privileges for a file it never re-wrote.
          history.closePullSession(
            pullId,
            normalizeConfigKey(configPath),
            survivingRefs,
          );
        }
        for (const session of sudoSessions.values()) session.close();
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
          for (const session of sudoSessions.values()) session.close();
          console.log('Aborted.');
          process.exit(0);
        }
      }

      // Phase 2: deferred sudo sessions — identities with readable changed
      // targets and stale-delete-only identities. These don't need pre-reads,
      // so they are opened here (after the user confirmed) rather than before
      // the diff is shown, avoiding an early password prompt.
      if (process.platform !== 'win32') {
        const deferredIds = new Set<true | string>();
        for (let i = 0; i < writeTargets.length; i++) {
          const t = writeTargets[i];
          if (t.sudo && allDiffs[i].hasChanges && !sudoSessions.has(t.sudo)) {
            deferredIds.add(t.sudo);
          }
        }
        for (let i = 0; i < staleToRestore.length; i++) {
          const t = staleToRestore[i];
          if (t.sudo) {
            const diffIdx = staleRestoreDiffIndices[i];
            if (staleDiffs[diffIdx]?.hasChanges && !sudoSessions.has(t.sudo)) {
              deferredIds.add(t.sudo);
            }
          }
        }
        // Thread 1: only add delete-only identities when the stale file still
        // exists (hasChanges). Identities for already-absent files are skipped
        // to avoid spurious password prompts on no-op runs.
        for (const [p, sv] of staleDeleteSudo) {
          const idx = staleDeleteDiffIndex.get(p);
          if (
            idx !== undefined &&
            staleDiffs[idx]?.hasChanges &&
            !sudoSessions.has(sv)
          ) {
            deferredIds.add(sv);
          }
        }
        try {
          for (const id of deferredIds)
            sudoSessions.set(id, new SudoWorkerSession(id));
        } catch (err) {
          for (const session of sudoSessions.values()) session.close();
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
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
            // For a first-seen unreadable sudo file, capture v0 so
            // revert-to-original works even when the invoking user cannot read
            // the file directly. The stat-read result from the pre-read batch
            // is used here — no additional sudo calls needed.
            let v0Override: Buffer | undefined;
            let v0IsSymlinkOverride = false;
            if (
              allDiffs[i].isUnreadable &&
              !allDiffs[i].isNew &&
              writeTargets[i].sudo &&
              !history.getFileMeta(targetPath)
            ) {
              const preRead = preReads.get(targetPath);
              if (preRead != null) {
                if (preRead.isSymlink) {
                  if (writeTargets[i].symlinkTarget !== undefined) {
                    // Destination is a symlink and so is the write target — record
                    // the existing link target as v0 for faithful revert/reset.
                    v0Override = Buffer.from(preRead.contentB64, 'base64');
                    v0IsSymlinkOverride = true;
                  }
                  // If the write target is a regular file but the destination is a
                  // symlink, skip v0: reading through the symlink could capture
                  // an unintended privileged file before write-path checks run.
                } else {
                  v0Override = Buffer.from(preRead.contentB64, 'base64');
                }
              }
            }
            const { fileRef } = history.stageFileVersion(
              pullId,
              targetPath,
              writeTargets[i].content,
              allDiffs[i].isNew,
              sourceShaRecords,
              writeTargets[i].sudo,
              v0Override,
              !!writeTargets[i].symlinkTarget,
              v0IsSymlinkOverride,
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

        // Collect sudo mode-only targets before the write batch so they can be
        // included in the same per-identity worker exec as the content writes.
        // This keeps all sudo ops (writes + chmods) in a single batch per
        // identity, so if any chmod fails the regular writes have not yet run
        // and the working tree remains in a consistent state.
        const modeOnlySudoTargets: SudoChmodTarget[] =
          process.platform !== 'win32'
            ? writeTargets.flatMap((t, i) =>
                allDiffs[i].modeChange && !allDiffs[i].contentChanged && t.sudo
                  ? [
                      {
                        targetPath: t.targetPath,
                        mode: allDiffs[i].modeChange.to
                          .toString(8)
                          .padStart(4, '0'),
                        sudo: t.sudo,
                      },
                    ]
                  : [],
              )
            : [];

        // Privileged writes first: if sudo fails, unprivileged files have not
        // yet changed, keeping the working tree in a consistent state.
        // Sessions are passed so reads and writes share the same worker process
        // (one sudo prompt total per identity). Chmod-only targets are batched
        // into the same per-identity exec as content writes so the ordering
        // guarantee extends to mode changes too.
        let modeOnlyCount = 0;
        if (
          sudoChanged.length + sudoRestore.length > 0 ||
          modeOnlySudoTargets.length > 0
        ) {
          modeOnlyCount = await sudoAtomicWrite(
            [...sudoChanged, ...sudoRestore],
            modeOnlySudoTargets,
            sudoSessions,
          );
        }
        atomicWrite([...regularChanged, ...regularRestore]);
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
        const sudoDeletionBatch: Array<[string, true | string]> = [];
        for (const [p, sv] of staleDeleteSudo) {
          const idx = staleDeleteDiffIndex.get(p);
          if (idx === undefined) continue;
          if (!staleDiffs[idx].hasChanges) {
            // File is already gone — no-op, but still clean up its history ref.
            effectivelyCleaned.add(p);
          } else {
            sudoDeletionBatch.push([p, sv]);
          }
        }
        if (sudoDeletionBatch.length > 0) {
          // Group by sudo identity; use the pre-created session if available
          const byDeleteId = new Map<true | string, string[]>();
          for (const [p, sv] of sudoDeletionBatch) {
            if (!byDeleteId.has(sv)) byDeleteId.set(sv, []);
            byDeleteId.get(sv)!.push(p);
          }
          for (const [sv, paths] of byDeleteId) {
            const session = sudoSessions.get(sv);
            if (session) {
              const deleteOps: WriteOp[] = paths.map((p) => ({
                type: 'delete' as const,
                targetPath: p,
              }));
              // Stale cleanup is best-effort: a session-level failure (worker
              // crash, auth error) is treated as a warning, not a fatal error.
              let deleteResults: WorkerResult[] = [];
              try {
                deleteResults = await session.exec(deleteOps, true);
              } catch (sessionErr) {
                for (const p of paths)
                  console.warn(
                    `Warning: could not delete ${p}: ${sessionErr instanceof Error ? sessionErr.message : String(sessionErr)}`,
                  );
                continue;
              }
              for (let di = 0; di < paths.length; di++) {
                if (deleteResults[di]?.ok && !deleteResults[di]?.skipped) {
                  effectivelyDeleted.add(paths[di]);
                  effectivelyCleaned.add(paths[di]);
                } else if (
                  deleteResults[di] &&
                  !deleteResults[di].ok &&
                  deleteResults[di].error
                ) {
                  console.warn(
                    `Warning: could not delete ${paths[di]}: ${deleteResults[di].error}`,
                  );
                }
              }
            } else {
              const batch: Array<[string, true | string]> = paths.map((p) => [
                p,
                sv,
              ]);
              const deleted = await sudoAtomicDelete(batch, true, sudoSessions);
              for (const p of paths) {
                if (deleted.has(p)) {
                  effectivelyDeleted.add(p);
                  effectivelyCleaned.add(p);
                }
              }
            }
          }
        }

        // Non-sudo mode-only changes (POSIX only). Sudo mode-only changes are
        // handled above via sudoAtomicWrite (chmodTargets argument).
        if (process.platform !== 'win32') {
          for (let i = 0; i < writeTargets.length; i++) {
            const d = allDiffs[i];
            if (d.modeChange && !d.contentChanged && !writeTargets[i].sudo) {
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
        for (const session of sudoSessions.values()) session.close();
        console.error(
          `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
      // Close worker sessions — stdin close signals the worker to exit cleanly.
      for (const session of sudoSessions.values()) session.close();

      // meta.sudo is updated by stageFileVersion for every file that was
      // actually written. No extra sync needed here: updating meta.sudo for
      // no-op targets would overwrite the privilege identity from the last
      // real write with a config value that was never applied to the file,
      // causing stale cleanup to run with the wrong credentials.

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
            // Preserve existing sudo on surviving refs — these files were not
            // rewritten this pull, so their on-disk ownership reflects the
            // previous write identity. Replacing with the current config value
            // would let stale cleanup run with the wrong privileges.
            refsToRecord = [
              ...survivingRefs.filter((r) => !stagedPaths.has(r.absolutePath)),
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
