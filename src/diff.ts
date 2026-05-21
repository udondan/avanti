import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { isBinary } from './binary';

export interface FileDiff {
  targetPath: string;
  isNew: boolean;
  isDelete?: boolean;
  hasChanges: boolean;
  contentChanged: boolean;
  patch: string;
  isBinary?: boolean;
  modeChange?: { from: number; to: number };
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  if (!fs.existsSync(targetPath)) {
    return {
      targetPath,
      isNew: false,
      hasChanges: false,
      contentChanged: false,
      patch: '',
    };
  }
  const oldBuf = fs.readFileSync(targetPath);
  if (isBinary(oldBuf)) {
    return {
      targetPath,
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    };
  }
  const oldContent = oldBuf.toString('utf8');
  const patch = createTwoFilesPatch(
    targetPath,
    '/dev/null',
    oldContent,
    '',
    undefined,
    'deleted',
  );
  return {
    targetPath,
    isNew: false,
    hasChanges: true,
    contentChanged: true,
    patch,
  };
}

export function computeDiff(
  targetPath: string,
  newContent: Buffer,
  desiredMode?: string,
): FileDiff {
  const isNew = !fs.existsSync(targetPath);
  const oldBuf = isNew ? Buffer.alloc(0) : fs.readFileSync(targetPath);

  let modeChange: { from: number; to: number } | undefined;
  if (!isNew && desiredMode) {
    const desired = parseInt(desiredMode, 8);
    const current = fs.statSync(targetPath).mode & 0o7777;
    if (desired !== current) {
      modeChange = { from: current, to: desired };
    }
  }

  const binary = isBinary(newContent) || isBinary(oldBuf);

  if (binary) {
    const contentChanged = isNew || !newContent.equals(oldBuf);
    const hasChanges = contentChanged || modeChange !== undefined;
    return {
      targetPath,
      isNew,
      hasChanges,
      contentChanged,
      patch: '',
      isBinary: true,
      modeChange,
    };
  }

  const oldContent = oldBuf.toString('utf8');
  const newText = newContent.toString('utf8');
  const contentChanged = oldContent !== newText;
  const hasChanges = contentChanged || modeChange !== undefined;

  const patch = contentChanged
    ? createTwoFilesPatch(
        isNew ? '/dev/null' : targetPath,
        targetPath,
        oldContent,
        newText,
        isNew ? '' : undefined,
        isNew ? 'new file' : undefined,
      )
    : '';

  return { targetPath, isNew, hasChanges, contentChanged, patch, modeChange };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';

  let out = '';

  if (diff.modeChange) {
    const from = diff.modeChange.from.toString(8).padStart(6, '0');
    const to = diff.modeChange.to.toString(8).padStart(6, '0');
    if (!diff.contentChanged) {
      // Mode-only: emit a file header since there is no content patch to own it.
      out +=
        chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) + '\n';
    }
    // Mode lines precede the content diff (mirrors git's format).
    out += chalk.red(`-old mode ${from}`) + '\n';
    out += chalk.green(`+new mode ${to}`) + '\n';
  }

  if (diff.isBinary) {
    if (diff.contentChanged) {
      const label = diff.isNew
        ? 'new binary file'
        : diff.isDelete
          ? 'binary file deleted'
          : 'binary file changed';
      const oldPath = diff.isNew ? '/dev/null' : diff.targetPath;
      const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
      out +=
        chalk.bold(`--- ${oldPath}\n+++ ${newPath}`) +
        '\n' +
        chalk.cyan(`@@ ${label} @@`);
    }
    return out;
  }

  if (diff.contentChanged) {
    const lines = diff.patch.split('\n');
    const colored = lines.map((line) => {
      if (line.startsWith('+++') || line.startsWith('---'))
        return chalk.bold(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      return line;
    });
    out += colored.join('\n');
  }

  return out;
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
