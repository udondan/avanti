import { Command } from 'commander';
import * as path from 'path';
import { normalizeConfigKey, resolveConfigPath } from '../config';
import { HistoryManager } from '../history';
import { computeDiff, computeDeleteDiff, printDiffs } from '../diff';
import { atomicWrite, WriteTarget } from '../writer';
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
          ? path.resolve(rawWorkingDir)
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
          { version: number; existedBeforeAvanti: boolean }
        >;

        if (pullId === undefined) {
          // Undo last pull: use the second-most-recent pull as target, or if none, pre-avanti
          snapshot =
            pulls.length > 1
              ? history.getFilesAtPull(pulls[1].pullId)
              : new Map<
                  string,
                  { version: number; existedBeforeAvanti: boolean }
                >(); // no prior pull → everything goes to pre-avanti state
        } else {
          snapshot = history.getFilesAtPull(targetPullId);
        }

        // Build restore plan
        const writeTargets: WriteTarget[] = [];
        const deletions: string[] = [];
        const diffs: FileDiff[] = [];

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
            const d = computeDiff(meta.absolutePath, content);
            if (d.hasChanges) {
              writeTargets.push({ targetPath: meta.absolutePath, content });
              diffs.push(d);
            }
          } else {
            // File was not present at target pull — go to pre-avanti state
            if (meta.existedBeforeAvanti) {
              const original = history.readVersion(meta.absolutePath, 0);
              if (original !== null) {
                const d = computeDiff(meta.absolutePath, original);
                if (d.hasChanges) {
                  writeTargets.push({
                    targetPath: meta.absolutePath,
                    content: original,
                  });
                  diffs.push(d);
                }
              }
            } else {
              const d = computeDeleteDiff(meta.absolutePath);
              if (d.hasChanges) {
                deletions.push(meta.absolutePath);
                diffs.push(d);
              }
            }
          }
        }

        if (diffs.length === 0) {
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
        printDiffs(diffs);

        const yes = opts.yes ?? false;
        if (!yes) {
          const ok = await confirm('Apply? [y/N] ');
          if (!ok) {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        try {
          atomicWrite(writeTargets, deletions);
          console.log(
            `Reverted ${writeTargets.length + deletions.length} file(s).`,
          );
        } catch (err: unknown) {
          console.error(
            `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(2);
        }
      },
    );
}
