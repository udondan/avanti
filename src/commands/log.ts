import { Command } from 'commander';
import * as path from 'path';
import { resolveConfigPath } from '../config';
import { HistoryManager } from '../history';

export function logCommand(): Command {
  return new Command('log')
    .description('Show pull history for the current project')
    .option('--file <path>', 'show version history for a specific file')
    .action((_options: unknown, cmd: Command) => {
      const opts = _options as { file?: string };
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();

      const history = new HistoryManager(configPath, workingDir);

      if (opts.file !== undefined) {
        showFileHistory(history, opts.file, workingDir);
      } else {
        showPullHistory(history);
      }
    });
}

function showPullHistory(history: HistoryManager): void {
  const pulls = history.listPulls();
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
    }
    console.log('');
  }
}

function showFileHistory(
  history: HistoryManager,
  filePath: string,
  workingDir: string,
): void {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDir, filePath);

  const fileHistory = history.getFileHistory(absolutePath);
  if (!fileHistory) {
    console.log(`No history for ${absolutePath}.`);
    return;
  }

  console.log(`${absolutePath}\n`);

  const versions = [...fileHistory.versions].reverse();
  for (const v of versions) {
    const vLabel = `v${v.version}`;
    const ts = v.pulledAt
      ? formatTimestamp(v.pulledAt)
      : '—                   ';
    const pullRef = v.pullId ? `pull ${v.pullId.slice(0, 8)}` : '—        ';
    let suffix = '';
    if (v.version === fileHistory.currentVersion) suffix = '  (current)';
    if (v.isOriginal) suffix = '  (original, before avanti)';
    console.log(`  ${vLabel.padEnd(4)}  ${ts}  ${pullRef}${suffix}`);
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
