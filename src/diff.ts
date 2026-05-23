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
  isUnreadable?: boolean;
  modeChange?: { from: number; to: number };
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  let oldBuf: Buffer;
  try {
    if (!fs.existsSync(targetPath)) {
      return {
        targetPath,
        isNew: false,
        hasChanges: false,
        contentChanged: false,
        patch: '',
      };
    }
    oldBuf = fs.readFileSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    // File exists but is unreadable (e.g. root-owned 0600).
    return {
      targetPath,
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
    };
  }
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
  let isNew: boolean;
  let oldBuf: Buffer;
  let isUnreadable = false;
  try {
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    isNew = stat === undefined;
    oldBuf = isNew ? Buffer.alloc(0) : fs.readFileSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    // File exists but is unreadable (e.g. root-owned 0600). Keep isNew=false
    // so history correctly records existedBeforeAvanti and backups are made.
    isNew = false;
    isUnreadable = true;
    oldBuf = Buffer.alloc(0);
  }

  let modeChange: { from: number; to: number } | undefined;
  if (!isNew && desiredMode && process.platform !== 'win32') {
    const desired = parseInt(desiredMode, 8);
    if (!isNaN(desired)) {
      try {
        const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
        if (stat !== undefined && !stat.isSymbolicLink()) {
          const current = stat.mode & 0o7777;
          if (desired !== current) {
            modeChange = { from: current, to: desired };
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'EPERM') throw err;
        // Cannot stat unreadable file — skip mode detection.
      }
    }
  }

  if (isUnreadable) {
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
      modeChange,
    };
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

  return {
    targetPath,
    isNew,
    hasChanges,
    contentChanged,
    patch,
    modeChange,
  };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';

  const colorLine = (line: string): string => {
    if (line.startsWith('+++') || line.startsWith('---'))
      return chalk.bold(line);
    if (line.startsWith('@@')) return chalk.cyan(line);
    if (line.startsWith('+')) return chalk.green(line);
    if (line.startsWith('-')) return chalk.red(line);
    return line;
  };

  let modeFrom = '';
  let modeTo = '';
  if (diff.modeChange) {
    modeFrom = chalk.red(
      `-old mode ${diff.modeChange.from.toString(8).padStart(6, '0')}`,
    );
    modeTo = chalk.green(
      `+new mode ${diff.modeChange.to.toString(8).padStart(6, '0')}`,
    );
  }

  if (diff.isUnreadable) {
    const oldPath = diff.isDelete ? diff.targetPath : diff.targetPath;
    const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
    const label = diff.isDelete
      ? 'file deleted (unreadable — no diff available)'
      : 'file updated (existing content unreadable — diff unavailable)';
    let out = chalk.bold(`--- ${oldPath}\n+++ ${newPath}`) + '\n';
    if (diff.modeChange) out += modeFrom + '\n' + modeTo + '\n';
    out += chalk.cyan(`@@ ${label} @@`);
    return out;
  }

  if (diff.isBinary) {
    let out = '';
    if (diff.contentChanged) {
      const label = diff.isNew
        ? 'new binary file'
        : diff.isDelete
          ? 'binary file deleted'
          : 'binary file changed';
      const oldPath = diff.isNew ? '/dev/null' : diff.targetPath;
      const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
      out += chalk.bold(`--- ${oldPath}\n+++ ${newPath}`) + '\n';
      if (diff.modeChange) out += modeFrom + '\n' + modeTo + '\n';
      out += chalk.cyan(`@@ ${label} @@`);
    } else if (diff.modeChange) {
      // Mode-only binary: emit file header + mode lines.
      out +=
        chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) + '\n';
      out += modeFrom + '\n' + modeTo;
    }
    return out;
  }

  if (diff.contentChanged) {
    const lines = diff.patch.split('\n');
    if (diff.modeChange) {
      // Inject mode lines after the +++ header line (git-style: header → mode
      // change → hunks). Find +++ by scan rather than fixed index because
      // createTwoFilesPatch may prepend Index:/=== lines before the header.
      const plusPlusIdx = lines.findIndex((l) => l.startsWith('+++'));
      if (plusPlusIdx >= 0) {
        const before = lines.slice(0, plusPlusIdx + 1).map(colorLine);
        const after = lines.slice(plusPlusIdx + 1).map(colorLine);
        return [...before, modeFrom, modeTo, ...after].join('\n');
      }
    }
    return lines.map(colorLine).join('\n');
  }

  // Mode-only text file.
  if (diff.modeChange) {
    return (
      chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) +
      '\n' +
      modeFrom +
      '\n' +
      modeTo
    );
  }

  return '';
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
