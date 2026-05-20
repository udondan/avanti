import { Command } from 'commander';
import * as path from 'path';
import { normalizeConfigKey, resolveConfigPath } from '../config';
import { HistoryManager, PullLogEntry } from '../history';

export function logCommand(): Command {
  return new Command('log')
    .description('Show pull history for the current project')
    .argument('[file]', 'show version history for a specific file')
    .action((file: string | undefined, _options: unknown, cmd: Command) => {
      const rawConfig = cmd.parent?.opts().config as string | undefined;
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();

      let managers: HistoryManager[];
      if (rawConfig !== undefined) {
        const configPath = resolveConfigPath(rawConfig);
        managers = [
          new HistoryManager(normalizeConfigKey(configPath), workingDir),
        ];
      } else {
        managers = HistoryManager.findByWorkingDir(workingDir);
        if (managers.length === 0) {
          // No history found for this workingDir; create an empty manager so
          // the "No history recorded yet." message is shown consistently.
          const configPath = resolveConfigPath(undefined);
          managers = [
            new HistoryManager(normalizeConfigKey(configPath), workingDir),
          ];
        }
      }

      if (file !== undefined) {
        showFileHistory(managers, file, workingDir);
      } else {
        showPullHistory(managers);
      }
    });
}

function showPullHistory(managers: HistoryManager[]): void {
  const pulls = managers
    .flatMap((m) => m.listPulls())
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (pulls.length === 0) {
    console.log('No history recorded yet.');
    return;
  }

  for (const pull of pulls) {
    const shortId = pull.pullId.slice(0, 8);
    const ts = formatTimestamp(pull.timestamp);
    const configName = path.basename(pull.configFile);
    console.log(`pull ${shortId}  ${ts}  ${configName}`);
    for (const ref of pull.files) {
      const label = ref.wasNew ? '(new file)' : '(modified)';
      console.log(`  ${ref.absolutePath}  → v${ref.version}  ${label}`);
      if (ref.sources && ref.sources.length > 0) {
        for (const s of ref.sources) {
          const shaShort = s.observedSha.slice(0, 16);
          if (s.accepted && s.expectedSha) {
            const prevShort = s.expectedSha.slice(0, 16);
            console.log(
              `    ${s.label}  sha:${shaShort}  ⚠ accepted (was: ${prevShort})`,
            );
          } else {
            console.log(`    ${s.label}  sha:${shaShort}`);
          }
        }
      }
    }
    console.log('');
  }
}

function showFileHistory(
  managers: HistoryManager[],
  filePath: string,
  workingDir: string,
): void {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDir, filePath);

  for (const history of managers) {
    const fileHistory = history.getFileHistory(absolutePath);
    if (!fileHistory) continue;

    console.log(`${absolutePath}\n`);

    const pulls = history.listPulls();
    const pullsById = new Map<string, PullLogEntry>(
      pulls.map((p) => [p.pullId, p]),
    );

    const versions = [...fileHistory.versions].reverse();
    for (const v of versions) {
      const vLabel = `v${v.version}`;
      const ts = v.pulledAt
        ? formatTimestamp(v.pulledAt)
        : '—                         ';
      const pullRef = v.pullId ? `pull ${v.pullId.slice(0, 8)}` : '—        ';
      let suffix = '';
      if (v.version === fileHistory.currentVersion) suffix = '  (current)';
      if (v.isOriginal) suffix = '  (original, before avanti)';
      console.log(`  ${vLabel.padEnd(4)}  ${ts}  ${pullRef}${suffix}`);

      if (v.pullId) {
        const pullEntry = pullsById.get(v.pullId);
        const fileRef = pullEntry?.files.find(
          (f) => f.absolutePath === absolutePath && f.version === v.version,
        );
        if (fileRef?.sources && fileRef.sources.length > 0) {
          for (const s of fileRef.sources) {
            const shaShort = s.observedSha.slice(0, 16);
            if (s.accepted && s.expectedSha) {
              const prevShort = s.expectedSha.slice(0, 16);
              console.log(
                `         ${s.label}  sha:${shaShort}  ⚠ accepted (was: ${prevShort})`,
              );
            } else {
              console.log(`         ${s.label}  sha:${shaShort}`);
            }
          }
        }
      }
    }
    return;
  }

  console.log(`No history for ${absolutePath}.`);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const tz = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz}`
  );
}
