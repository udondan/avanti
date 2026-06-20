import { Command } from 'commander';
import * as path from 'path';
import { normalizeConfigKey, resolveConfigPath } from '../config';
import { expandTilde } from '../paths';
import { HistoryManager } from '../history';
import {
  computeDiff,
  computeDeleteDiff,
  computeSymlinkDiff,
  printDiffs,
} from '../diff';
import {
  atomicWrite,
  sudoAtomicDelete,
  sudoAtomicWrite,
  SudoWorkerSession,
  SudoWriteTarget,
  WriteTarget,
} from '../writer';
import { confirm } from '../prompt';
import { FileDiff } from '../diff';

export function revertCommand(): Command {
  return new Command('revert')
    .description(
      'Atomically revert all project files to a past pull state (defaults to undoing the last pull)',
    )
    .argument(
      '[pullId]',
      'short or full pull ID to revert to (from avanti log)',
    )
    .option('-y, --yes', 'skip confirmation prompt')
    .action(
      async (pullId: string | undefined, options: unknown, cmd: Command) => {
        const opts = options as { yes?: boolean };
        const configPath = resolveConfigPath(
          cmd.parent?.opts().config as string | undefined,
        );
        const rawWorkingDir = cmd.parent?.opts().workingDir as
          | string
          | undefined;
        const workingDir = rawWorkingDir
          ? path.resolve(expandTilde(rawWorkingDir))
          : process.cwd();

        const history = new HistoryManager(
          normalizeConfigKey(configPath),
          workingDir,
        );
        if (!history.hasHistory()) {
          console.error('No history found. Run avanti pull first.');
          process.exit(2);
        }

        const pulls = history.listPulls(); // newest first
        if (pulls.length === 0) {
          console.log('No pull history recorded yet.');
          process.exit(0);
        }

        let targetPullId: string;
        if (pullId === undefined) {
          // Undo the last pull: restore state from before it (second entry, or pre-avanti)
          targetPullId = pulls[0].pullId;
        } else {
          const matched = pulls.find(
            (p) => p.pullId === pullId || p.pullId.startsWith(pullId),
          );
          if (!matched) {
            console.error(`No pull found matching ID "${pullId}".`);
            process.exit(2);
          }
          targetPullId = matched.pullId;
        }

        // When undoing the last pull, we want the state BEFORE it — i.e. the second pull's state
        // When reverting TO a specific pull, we want the state AFTER that pull
        let snapshot: Map<
          string,
          { version: number; existedBeforeAvanti: boolean; isSymlink?: boolean }
        >;

        if (pullId === undefined) {
          // Undo last pull: use the second-most-recent pull as target, or if none, pre-avanti
          snapshot =
            pulls.length > 1
              ? history.getFilesAtPull(pulls[1].pullId)
              : new Map<
                  string,
                  {
                    version: number;
                    existedBeforeAvanti: boolean;
                    isSymlink?: boolean;
                  }
                >(); // no prior pull → everything goes to pre-avanti state

          // A file with wasNew=true in the last pull was created from scratch (it
          // did not exist on disk before that pull ran). Even if an earlier pull
          // also created it, the correct "before last pull" state is: not present.
          for (const ref of pulls[0].files) {
            if (ref.wasNew) {
              snapshot.delete(ref.absolutePath);
            }
          }
        } else {
          snapshot = history.getFilesAtPull(targetPullId);
        }

        // Build restore plan
        const writeTargets: WriteTarget[] = [];
        const deletions: string[] = [];
        const sudoDeletions = new Map<string, true | string>();
        const diffs: FileDiff[] = [];
        let hasError = false;

        const allTracked = history.listTrackedFiles();

        for (const meta of allTracked) {
          const entry = snapshot.get(meta.absolutePath);
          if (entry !== undefined) {
            // File existed at target pull — restore that version
            const content = history.readVersion(
              meta.absolutePath,
              entry.version,
            );
            if (content === null) continue;
            if (entry.isSymlink) {
              if (process.platform === 'win32') {
                console.error(
                  `symlink: ${meta.absolutePath}: cannot restore symlink on Windows`,
                );
                hasError = true;
                continue;
              }
              const symlinkTarget = content.toString('utf8');
              const d = computeSymlinkDiff(meta.absolutePath, symlinkTarget);
              if (d.isDirectory) {
                console.error(
                  `symlink: ${meta.absolutePath} is a directory; cannot restore symlink over directory`,
                );
                hasError = true;
                diffs.push(d);
              } else if (d.hasChanges) {
                writeTargets.push({
                  targetPath: meta.absolutePath,
                  content,
                  symlinkTarget,
                  sudo: meta.sudo,
                });
                diffs.push(d);
              }
            } else {
              const d = computeDiff(meta.absolutePath, content);
              if (d.hasChanges) {
                writeTargets.push({
                  targetPath: meta.absolutePath,
                  content,
                  sudo: meta.sudo,
                });
                diffs.push(d);
              }
            }
          } else {
            // File was not present at target pull — go to pre-avanti state
            if (meta.existedBeforeAvanti) {
              const original = history.readVersion(meta.absolutePath, 0);
              if (original !== null) {
                if (meta.v0IsSymlink) {
                  if (process.platform === 'win32') {
                    console.error(
                      `symlink: ${meta.absolutePath}: cannot restore pre-avanti symlink on Windows`,
                    );
                    hasError = true;
                    continue;
                  }
                  const symlinkTarget = original.toString('utf8');
                  const d = computeSymlinkDiff(
                    meta.absolutePath,
                    symlinkTarget,
                  );
                  if (d.isDirectory) {
                    console.error(
                      `symlink: ${meta.absolutePath} is a directory; cannot restore symlink over directory`,
                    );
                    hasError = true;
                    diffs.push(d);
                  } else if (d.hasChanges) {
                    writeTargets.push({
                      targetPath: meta.absolutePath,
                      content: original,
                      symlinkTarget,
                      sudo: meta.sudo,
                    });
                    diffs.push(d);
                  }
                } else {
                  const d = computeDiff(meta.absolutePath, original);
                  if (d.hasChanges) {
                    writeTargets.push({
                      targetPath: meta.absolutePath,
                      content: original,
                      sudo: meta.sudo,
                    });
                    diffs.push(d);
                  }
                }
              }
            } else {
              const d = computeDeleteDiff(meta.absolutePath);
              if (d.hasChanges) {
                if (meta.sudo) {
                  sudoDeletions.set(meta.absolutePath, meta.sudo);
                } else {
                  deletions.push(meta.absolutePath);
                }
                diffs.push(d);
              }
            }
          }
        }

        if (diffs.length === 0 && !hasError) {
          console.log(
            'Nothing to revert — files already match the target state.',
          );
          process.exit(0);
        }

        const shortId = targetPullId.slice(0, 8);
        const label =
          pullId === undefined
            ? `Undoing last pull (${shortId})`
            : `Reverting to state after pull ${shortId}`;
        console.log(`${label}:\n`);
        if (diffs.length > 0) {
          printDiffs(diffs);
        }

        if (hasError) process.exit(2);

        const yes = opts.yes ?? false;
        if (!yes) {
          const ok = await confirm('Apply? [y/N] ');
          if (!ok) {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        const isSudoTarget = (t: WriteTarget): t is SudoWriteTarget => !!t.sudo;
        const regularTargets = writeTargets.filter((t) => !t.sudo);
        const sudoTargets = writeTargets.filter(isSudoTarget);

        // Create one shared session per sudo identity so that sudoAtomicWrite
        // and sudoAtomicDelete share a single worker process (one password
        // prompt total, regardless of timestamp_timeout).
        const sudoSessions = new Map<true | string, SudoWorkerSession>();
        if (process.platform !== 'win32') {
          const sudoIds = new Set<true | string>([
            ...sudoTargets.map((t) => t.sudo),
            ...[...sudoDeletions.values()],
          ]);
          try {
            for (const id of sudoIds)
              sudoSessions.set(id, new SudoWorkerSession(id));
          } catch (err) {
            for (const session of sudoSessions.values()) session.close();
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(2);
          }
        }

        try {
          // Perform privileged operations first: if sudo fails, the
          // unprivileged writes have not yet happened, keeping the project in a
          // consistent (if incomplete) state.
          if (process.platform !== 'win32') {
            if (sudoTargets.length > 0)
              await sudoAtomicWrite(sudoTargets, [], sudoSessions);
            await sudoAtomicDelete([...sudoDeletions], false, sudoSessions);
          }
          atomicWrite(regularTargets, deletions);
          const total =
            writeTargets.length + deletions.length + sudoDeletions.size;
          console.log(`Reverted ${total} file(s).`);
        } catch (err: unknown) {
          console.error(
            `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(2);
        } finally {
          for (const session of sudoSessions.values()) session.close();
        }
      },
    );
}
