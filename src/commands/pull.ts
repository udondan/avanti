import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
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

function writeUpdatedShas(configPath: string, accepted: ShaError[]): void {
  if (accepted.length === 0) return;
  const raw = fs.readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);

  const acceptedByLabel = new Map(
    accepted.map((e) => [e.sourceLabel, e.observedSha]),
  );

  const filesNode = doc.get('files', true);
  if (!filesNode || typeof filesNode !== 'object' || !('items' in filesNode))
    return;

  const filesSeq = filesNode as { items: unknown[] };
  for (const fileItem of filesSeq.items) {
    if (!fileItem || typeof fileItem !== 'object' || !('value' in fileItem))
      continue;
    const rawValue = (fileItem as Record<string, unknown>).value;
    if (!rawValue || typeof rawValue !== 'object' || !('get' in rawValue))
      continue;
    const entryNode = rawValue as {
      get: (k: string, keepScalar?: boolean) => unknown;
    };

    const srcNode = entryNode.get('src', true);
    if (!srcNode) continue;

    const processSrc = (
      srcItem: unknown,
      srcIdx: number,
      fileIdx: number,
    ): void => {
      if (!srcItem || typeof srcItem !== 'object') return;

      // Determine the source label to match
      let label: string | null = null;
      let shaPath: (string | number)[] | null = null;

      const n = srcItem as {
        get?: (k: string, keepScalar?: boolean) => unknown;
      };
      if (!n.get) return;

      if (n.get('github')) {
        const gh = n.get('github') as {
          get?: (k: string, keepScalar?: boolean) => unknown;
        } | null;
        if (gh?.get) {
          const repo = gh.get('repo') as string | null;
          const file = gh.get('file') as string | null;
          if (repo && file) {
            label = `github:${repo}:${file}`;
            shaPath = ['files', fileIdx, 'src', srcIdx, 'github', 'sha'];
          }
        }
      } else if (n.get('gitlab')) {
        const gl = n.get('gitlab') as {
          get?: (k: string, keepScalar?: boolean) => unknown;
        } | null;
        if (gl?.get) {
          const project = gl.get('project') as string | null;
          const file = gl.get('file') as string | null;
          if (project && file) {
            label = `gitlab:${project}:${file}`;
            shaPath = ['files', fileIdx, 'src', srcIdx, 'gitlab', 'sha'];
          }
        }
      } else if (n.get('bitbucket')) {
        const bb = n.get('bitbucket') as {
          get?: (k: string, keepScalar?: boolean) => unknown;
        } | null;
        if (bb?.get) {
          const ws = bb.get('workspace') as string | null;
          const repo = bb.get('repo') as string | null;
          const file = bb.get('file') as string | null;
          if (ws && repo && file) {
            label = `bitbucket:${ws}/${repo}:${file}`;
            shaPath = ['files', fileIdx, 'src', srcIdx, 'bitbucket', 'sha'];
          }
        }
      } else if (n.get('git')) {
        const gt = n.get('git') as {
          get?: (k: string, keepScalar?: boolean) => unknown;
        } | null;
        if (gt?.get) {
          const repo = gt.get('repo') as string | null;
          const file = gt.get('file') as string | null;
          if (repo && file) {
            label = `git:${repo}:${file}`;
            shaPath = ['files', fileIdx, 'src', srcIdx, 'git', 'sha'];
          }
        }
      } else if (n.get('exec') !== undefined) {
        const cmd = n.get('exec') as string | null;
        if (cmd) {
          label = `exec:${cmd}`;
          shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
        }
      } else if (n.get('s3') !== undefined) {
        const s3 = n.get('s3') as string | null;
        if (s3) {
          label = `s3:${s3}`;
          shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
        }
      } else if (n.get('vault')) {
        const vt = n.get('vault') as {
          get?: (k: string, keepScalar?: boolean) => unknown;
        } | null;
        if (vt?.get) {
          const p = vt.get('path') as string | null;
          if (p) {
            label = `vault:${p}`;
            shaPath = ['files', fileIdx, 'src', srcIdx, 'vault', 'sha'];
          }
        }
      } else if (n.get('http') !== undefined) {
        const url = n.get('http') as string | null;
        if (url) {
          label = `http:${url}`;
          shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
        }
      }

      if (label && shaPath && acceptedByLabel.has(label)) {
        doc.setIn(shaPath, acceptedByLabel.get(label)!);
      }
    };

    if (srcNode && typeof srcNode === 'object' && 'items' in srcNode) {
      const srcSeq = srcNode as { items: unknown[] };
      let fileIdx = 0;
      for (const fi of filesSeq.items) {
        if (fi === fileItem) break;
        fileIdx++;
      }
      srcSeq.items.forEach((item, idx) => {
        if (item && typeof item === 'object' && 'value' in item) {
          processSrc((item as Record<string, unknown>).value, idx, fileIdx);
        } else {
          processSrc(item, idx, fileIdx);
        }
      });
    } else {
      let fileIdx = 0;
      for (const fi of filesSeq.items) {
        if (fi === fileItem) break;
        fileIdx++;
      }
      // Single src (not an array) — wrap in the map node directly
      processSrc(srcNode, 0, fileIdx);
    }
  }

  fs.writeFileSync(configPath, doc.toString(), 'utf8');
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
            }
            writeTargets = second.writeTargets;
            allDiffs = second.allDiffs;
            sourceRecordsByTarget = second.sourceRecordsByTarget;
            firstPass.shaErrors.push(...second.shaErrors);
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

      // Stage history versions before atomicWrite so v0 is captured before overwrite
      const stagedFileRefs: PullLogFileRef[] = [];
      if (pullId) {
        for (let i = 0; i < writeTargets.length; i++) {
          if (!allDiffs[i].hasChanges) continue;
          try {
            const targetPath = writeTargets[i].targetPath;
            const records = sourceRecordsByTarget.get(targetPath);
            const sourceShaRecords: SourceShaRecord[] | undefined =
              records !== undefined
                ? records.map((r) => ({
                    label: r.sourceLabel,
                    observedSha: r.observedSha,
                    expectedSha: r.expectedSha,
                    accepted:
                      !r.matched &&
                      (opts.acceptChanges ?? false) &&
                      firstPass.shaErrors.some(
                        (e) => e.sourceLabel === r.sourceLabel,
                      ),
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

      // SHA writeback: write updated sha values into config file after all writes complete
      if (
        opts.acceptChanges &&
        firstPass.shaErrors.length > 0 &&
        !isRemoteConfigSpec(configPath)
      ) {
        try {
          writeUpdatedShas(configPath, firstPass.shaErrors);
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
