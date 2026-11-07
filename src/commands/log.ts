import { Command } from 'commander';
import * as path from 'path';
import { normalizeConfigKey, resolveConfigPath } from '../config';
import {
  HistoryManager,
  PullLogEntry,
  PullLogFileRef,
  SourceShaRecord,
  writtenRefs,
} from '../history';
import { formatSourceLabel } from '../sources';
import { resolveWorkingDir } from './project';

type FileHistory = NonNullable<ReturnType<HistoryManager['getFileHistory']>>;
type FileVersion = FileHistory['versions'][number];

export function logCommand(): Command {
  return new Command('log')
    .description('Show pull history for the current project')
    .argument('[file]', 'show version history for a specific file')
    .action((file: string | undefined, _options: unknown, cmd: Command) => {
      const rawConfig = cmd.parent?.opts().config as string | undefined;
      const workingDir = resolveWorkingDir(cmd);
      const managers = resolveManagers(rawConfig, workingDir);

      if (file !== undefined) {
        showFileHistory(managers, file, workingDir);
      } else {
        showPullHistory(managers);
      }
    });
}

function resolveManagers(
  rawConfig: string | undefined,
  workingDir: string,
): HistoryManager[] {
  if (rawConfig !== undefined) {
    const configPath = resolveConfigPath(rawConfig);
    return [new HistoryManager(normalizeConfigKey(configPath), workingDir)];
  }
  const managers = HistoryManager.findByWorkingDir(workingDir);
  if (managers.length > 0) return managers;
  // No history found for this workingDir; create an empty manager so
  // the "No history recorded yet." message is shown consistently.
  const configPath = resolveConfigPath();
  return [new HistoryManager(normalizeConfigKey(configPath), workingDir)];
}

function printSources(
  sources: SourceShaRecord[] | undefined,
  indent: string,
): void {
  for (const s of sources ?? []) {
    const shaShort = s.observedSha.slice(0, 16);
    if (s.accepted && s.expectedSha) {
      const prevShort = s.expectedSha.slice(0, 16);
      console.log(
        `${indent}${formatSourceLabel(s.label)}  sha:${shaShort}  ⚠ accepted (was: ${prevShort})`,
      );
    } else {
      console.log(`${indent}${formatSourceLabel(s.label)}  sha:${shaShort}`);
    }
  }
}

function printPull(pull: PullLogEntry): void {
  const shortId = pull.pullId.slice(0, 8);
  const ts = formatTimestamp(pull.timestamp);
  const configName = path.basename(pull.configFile);
  console.log(`pull ${shortId}  ${ts}  ${configName}`);
  for (const ref of pull.files) {
    const label = ref.wasNew ? '(new file)' : '(modified)';
    console.log(`  ${ref.absolutePath}  → v${ref.version}  ${label}`);
    printSources(ref.sources, '    ');
  }
  console.log('');
}

function showPullHistory(managers: HistoryManager[]): void {
  // Each manager has its own pull log, so carried-over refs are detected
  // per manager. listPulls() is newest first: the previous entry is i + 1.
  const pulls = managers
    .flatMap((m) =>
      m.listPulls().map((pull, i, all) => ({
        ...pull,
        files: writtenRefs(pull, all[i + 1]),
      })),
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (pulls.length === 0) {
    console.log('No history recorded yet.');
    return;
  }

  for (const pull of pulls) {
    printPull(pull);
  }
}

function latestPullTimestamp(history: HistoryManager): string {
  return history.listPulls()[0]?.timestamp ?? '';
}

function versionSuffix(v: FileVersion, currentVersion: number): string {
  if (v.isOriginal) return '  (original, before avanti)';
  if (v.version === currentVersion) return '  (current)';
  return '';
}

function findFileRef(
  pullsById: Map<string, PullLogEntry>,
  pullId: string,
  absolutePath: string,
  version: number,
): PullLogFileRef | undefined {
  return pullsById
    .get(pullId)
    ?.files.find(
      (f) => f.absolutePath === absolutePath && f.version === version,
    );
}

function printFileVersions(
  history: HistoryManager,
  fileHistory: FileHistory,
): void {
  const { absolutePath } = fileHistory;
  const pullsById = new Map<string, PullLogEntry>(
    history.listPulls().map((p) => [p.pullId, p]),
  );

  const versions = [...fileHistory.versions].reverse();
  for (const v of versions) {
    const vLabel = `v${v.version}`;
    const ts = v.pulledAt
      ? formatTimestamp(v.pulledAt)
      : '—                         ';
    const pullRef = v.pullId ? `pull ${v.pullId.slice(0, 8)}` : '—        ';
    const suffix = versionSuffix(v, fileHistory.currentVersion);
    console.log(`  ${vLabel.padEnd(4)}  ${ts}  ${pullRef}${suffix}`);

    if (v.pullId) {
      const fileRef = findFileRef(pullsById, v.pullId, absolutePath, v.version);
      printSources(fileRef?.sources, '         ');
    }
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

  const sortedManagers = [...managers].sort((a, b) =>
    latestPullTimestamp(b).localeCompare(latestPullTimestamp(a)),
  );

  for (const history of sortedManagers) {
    const fileHistory = history.getFileHistory(absolutePath);
    if (!fileHistory) continue;

    console.log(`${absolutePath}\n`);
    printFileVersions(history, fileHistory);
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
