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
  AtomicWritePartialError,
  closeAllSessions,
  openPrivilegedSessions,
  sudoAtomicDelete,
  sudoAtomicWrite,
  SudoWorkerSession,
  SudoWritePartialError,
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

      // Create one shared session per sudo identity so that sudoAtomicWrite
      // and sudoAtomicDelete share a single worker process (one password
      // prompt total, regardless of timestamp_timeout).
      const sudoIds = new Set<true | string>([
        ...sudoTargets.map((t) => t.sudo),
        ...sudoDeletions.values(),
      ]);
      let sudoSessions: Map<true | string, SudoWorkerSession> = new Map();
      try {
        sudoSessions = openPrivilegedSessions(sudoIds);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        closeAllSessions(sudoSessions);
        process.exit(2);
      }

      // Set to true once sudoAtomicWrite returns without throwing so the catch
      // block can warn about sudo files already on disk when atomicWrite fails.
      let sudoWriteComplete = false;

      try {
        // Perform privileged operations first: if sudo fails, the
        // unprivileged writes have not yet happened, keeping the project in a
        // consistent (if incomplete) state.
        if (process.platform !== 'win32') {
          if (sudoTargets.length > 0) {
            await sudoAtomicWrite(sudoTargets, [], sudoSessions);
            sudoWriteComplete = true;
          }
          if (sudoDeletions.size > 0)
            await sudoAtomicDelete([...sudoDeletions], false, sudoSessions);
        } else if (sudoTargets.length > 0 || sudoDeletions.size > 0) {
          const n = sudoTargets.length + sudoDeletions.size;
          console.warn(
            `Warning: ${n} privileged file(s) were not reset — sudo is not supported on Windows.`,
          );
        }
        atomicWrite(regularTargets, deletions);
        console.log(
          `Restored ${writeTargets.length} file(s), deleted ${deletions.length + sudoDeletions.size} file(s).`,
        );
      } catch (err: unknown) {
        // Determine which paths were written before the failure so the user
        // knows what the reset partially applied.
        // Case (a): SudoWritePartialError — err.writtenPaths lists sudo writes.
        // Case (b): sudoWriteComplete + AtomicWritePartialError — sudoAtomicWrite
        //           succeeded; err.writtenPaths lists regular files renamed/written.
        // Case (c): sudoWriteComplete + plain Error — sudoAtomicWrite succeeded;
        //           atomicWrite failed before any rename; only sudo files are on disk.
        let writtenPaths: string[] | null = null;
        if (err instanceof SudoWritePartialError) {
          writtenPaths = err.writtenPaths;
        } else if (sudoWriteComplete) {
          writtenPaths = [
            ...sudoTargets.map((t) => t.targetPath),
            ...(err instanceof AtomicWritePartialError ? err.writtenPaths : []),
          ];
        } else if (err instanceof AtomicWritePartialError) {
          writtenPaths = err.writtenPaths;
        }
        if (writtenPaths !== null && writtenPaths.length > 0) {
          console.warn(
            `Warning: partial reset — the following ${writtenPaths.length} file(s) were written before the failure:`,
          );
          for (const p of writtenPaths) {
            console.warn(`  ${p}`);
          }
        }
        console.error(
          `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 2;
        return;
      } finally {
        closeAllSessions(sudoSessions);
      }
    });
}
