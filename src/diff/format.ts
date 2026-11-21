import chalk from 'chalk';
import type { FileDiff, ModeChange } from './types';

interface ModeLines {
  from: string;
  to: string;
}

function colorLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
  if (line.startsWith('@@')) return chalk.cyan(line);
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return line;
}

function header(oldPath: string, newPath: string): string {
  return chalk.bold(`--- ${oldPath}\n+++ ${newPath}`);
}

function formatModeLines(
  modeChange: ModeChange | undefined,
): ModeLines | undefined {
  if (!modeChange) return undefined;
  return {
    from: chalk.red(
      `-old mode ${modeChange.from.toString(8).padStart(6, '0')}`,
    ),
    to: chalk.green(`+new mode ${modeChange.to.toString(8).padStart(6, '0')}`),
  };
}

/** Header, optional mode lines and a `@@ label @@` placeholder hunk. */
function labelledDiff(
  oldPath: string,
  newPath: string,
  mode: ModeLines | undefined,
  label: string,
): string {
  let out = header(oldPath, newPath) + '\n';
  if (mode) out += mode.from + '\n' + mode.to + '\n';
  out += chalk.cyan(`@@ ${label} @@`);
  return out;
}

function modeOnlyDiff(targetPath: string, mode: ModeLines): string {
  return header(targetPath, targetPath) + '\n' + mode.from + '\n' + mode.to;
}

function formatSymlinkDiff(diff: FileDiff): string {
  if (diff.isDirectory) {
    return (
      header(diff.targetPath, diff.targetPath) +
      '\n' +
      chalk.red(
        '@@ ERROR: target is an existing directory; symlinks cannot replace directories @@',
      )
    );
  }
  if (diff.isUnreadable) {
    const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
    const label = diff.isDelete
      ? 'symlink deleted (existing target unreadable — diff unavailable)'
      : 'symlink (existing state unreadable)';
    return labelledDiff(diff.targetPath, newPath, undefined, label);
  }
  return diff.patch.split('\n').map(colorLine).join('\n');
}

function formatUnreadableDiff(
  diff: FileDiff,
  mode: ModeLines | undefined,
): string {
  const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
  const label = diff.isDelete
    ? 'file deleted (unreadable — no diff available)'
    : 'file updated (existing content unreadable — diff unavailable)';
  return labelledDiff(diff.targetPath, newPath, mode, label);
}

function binaryLabel(diff: FileDiff): string {
  if (diff.isNew) return 'new binary file';
  if (diff.isDelete) return 'binary file deleted';
  return 'binary file changed';
}

function formatBinaryDiff(diff: FileDiff, mode: ModeLines | undefined): string {
  if (diff.contentChanged) {
    const oldPath = diff.isNew ? '/dev/null' : diff.targetPath;
    const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
    return labelledDiff(oldPath, newPath, mode, binaryLabel(diff));
  }
  // Mode-only binary: emit file header + mode lines.
  return mode ? modeOnlyDiff(diff.targetPath, mode) : '';
}

function formatPatch(patch: string, mode: ModeLines | undefined): string {
  const lines = patch.split('\n');
  if (mode) {
    // Inject mode lines after the +++ header line (git-style: header → mode
    // change → hunks). Find +++ by scan rather than fixed index because
    // createTwoFilesPatch may prepend Index:/=== lines before the header.
    const plusPlusIdx = lines.findIndex((l) => l.startsWith('+++'));
    if (plusPlusIdx >= 0) {
      const before = lines.slice(0, plusPlusIdx + 1).map(colorLine);
      const after = lines.slice(plusPlusIdx + 1).map(colorLine);
      return [...before, mode.from, mode.to, ...after].join('\n');
    }
  }
  return lines.map(colorLine).join('\n');
}

function formatTextDiff(diff: FileDiff, mode: ModeLines | undefined): string {
  if (diff.contentChanged) return formatPatch(diff.patch, mode);
  // Mode-only text file.
  return mode ? modeOnlyDiff(diff.targetPath, mode) : '';
}

/**
 * If content was confirmed unchanged via sudo re-read (contentChanged=false),
 * fall through to mode-only rendering so the diff accurately shows only the
 * permission change rather than the "unreadable content" placeholder.
 */
function showsUnreadablePlaceholder(diff: FileDiff): boolean {
  if (!diff.isUnreadable) return false;
  return diff.contentChanged || !diff.modeChange;
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';
  if (diff.isSymlink) return formatSymlinkDiff(diff);

  const mode = formatModeLines(diff.modeChange);
  if (showsUnreadablePlaceholder(diff)) return formatUnreadableDiff(diff, mode);
  if (diff.isBinary) return formatBinaryDiff(diff, mode);
  return formatTextDiff(diff, mode);
}

export function printDiffs(diffs: FileDiff[]): void {
  const changed = diffs.filter((d) => d.hasChanges);
  if (!changed.length) {
    console.log('No changes.');
    return;
  }
  for (const d of changed) {
    console.log(formatDiff(d));
  }
}
