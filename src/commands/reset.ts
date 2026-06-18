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
  sudoAtomicWrite,
  sudoDelete,
  SudoWriteTarget,
  WriteTarget,
} from '../writer';
import { confirm } from '../prompt';
import { FileDiff } from '../diff';

export function resetCommand(): Command {
  return new Command('reset')
    .description(
      'Restore all tracked files to their pre-avanti state, deleting files avanti created',
    )
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { yes?: boolean };
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(expandTilde(rawWorkingDir))
        : process.cwd();

      const history = new HistoryManager(
        normalizeConfigKey(configPath),
        workingDir,
      );
      if (!history.hasHistory()) {
        console.log('No avanti history found. Nothing to reset.');
        process.exit(0);
      }

      const tracked = history.listTrackedFiles();
      if (tracked.length === 0) {
        console.log('No tracked files. Nothing to reset.');
        process.exit(0);
      }

      const writeTargets: WriteTarget[] = [];
      const deletions: string[] = [];
      const sudoDeletions = new Map<string, true | string>();
      const diffs: FileDiff[] = [];
      let hasError = false;

      for (const meta of tracked) {
        if (meta.existedBeforeAvanti) {
          const original = history.readVersion(meta.absolutePath, 0);
          if (original === null) continue;
          if (meta.v0IsSymlink) {
            if (process.platform === 'win32') {
              console.error(
                `symlink: ${meta.absolutePath}: cannot restore pre-avanti symlink on Windows`,
              );
              hasError = true;
              continue;
            }
            const symlinkTarget = original.toString('utf8');
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

      if (diffs.length === 0 && !hasError) {
        console.log(
          'Files are already at their pre-avanti state. Nothing to reset.',
        );
        process.exit(0);
      }

      const total = writeTargets.length + deletions.length + sudoDeletions.size;
      if (total > 0) {
        console.log(
          `This will restore ${total} tracked file(s) to their pre-avanti state:\n`,
        );
      }
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

      try {
        // Perform privileged operations first: if sudo fails, the
        // unprivileged writes have not yet happened, keeping the project in a
        // consistent (if incomplete) state.
        if (sudoTargets.length > 0) sudoAtomicWrite(sudoTargets);
        for (const [p, sv] of sudoDeletions) {
          sudoDelete(p, sv);
        }
        atomicWrite(regularTargets, deletions);
        console.log(
          `Restored ${writeTargets.length} file(s), deleted ${deletions.length + sudoDeletions.size} file(s).`,
        );
      } catch (err: unknown) {
        console.error(
          `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });
}
