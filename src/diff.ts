import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { Variables } from './types';
import { resolveVars } from './variables';
import { isBinary } from './binary';

export interface FileDiff {
  targetPath: string;
  isNew: boolean;
  isDelete?: boolean;
  hasChanges: boolean;
  patch: string;
  isBinary?: boolean;
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  if (!fs.existsSync(targetPath)) {
    return { targetPath, isNew: false, hasChanges: false, patch: '' };
  }
  const oldBuf = fs.readFileSync(targetPath);
  if (isBinary(oldBuf)) {
    return {
      targetPath,
      isNew: false,
      isDelete: true,
      hasChanges: true,
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
  return { targetPath, isNew: false, hasChanges: true, patch };
}

export function computeDiff(targetPath: string, newContent: Buffer): FileDiff {
  const isNew = !fs.existsSync(targetPath);
  const oldBuf = isNew ? Buffer.alloc(0) : fs.readFileSync(targetPath);

  const binary = isBinary(newContent) || isBinary(oldBuf);

  if (binary) {
    const hasChanges = isNew || !newContent.equals(oldBuf);
    return { targetPath, isNew, hasChanges, patch: '', isBinary: true };
  }

  const oldContent = oldBuf.toString('utf8');
  const newText = newContent.toString('utf8');
  const hasChanges = oldContent !== newText;

  const patch = createTwoFilesPatch(
    isNew ? '/dev/null' : targetPath,
    targetPath,
    oldContent,
    newText,
    isNew ? '' : undefined,
    isNew ? 'new file' : undefined,
  );

  return { targetPath, isNew, hasChanges, patch };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';

  if (diff.isBinary) {
    const label = diff.isNew
      ? 'new binary file'
      : diff.isDelete
        ? 'binary file deleted'
        : 'binary file changed';
    const oldPath = diff.isNew ? '/dev/null' : diff.targetPath;
    const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
    return (
      chalk.bold(`--- ${oldPath}\n+++ ${newPath}`) +
      '\n' +
      chalk.cyan(`@@ ${label} @@`)
    );
  }

  const lines = diff.patch.split('\n');
  const colored = lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---'))
      return chalk.bold(line);
    if (line.startsWith('@@')) return chalk.cyan(line);
    if (line.startsWith('+')) return chalk.green(line);
    if (line.startsWith('-')) return chalk.red(line);
    return line;
  });
  return colored.join('\n');
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

export function resolveTargetPath(
  entry: { target?: string },
  relPath: string,
  workingDir: string,
  vars: Variables = {},
): string {
  let resolved: string;
  const target = entry.target ? resolveVars(entry.target, vars) : undefined;

  if (target) {
    if (target.startsWith('~/')) {
      const expanded = path.join(os.homedir(), target.slice(2));
      if (expanded.endsWith('/') || expanded.endsWith(path.sep)) {
        return path.resolve(expanded, relPath);
      }
      return expanded;
    }
    if (path.isAbsolute(target)) {
      const fsRoot = path.parse(workingDir).root;
      if (workingDir !== fsRoot) {
        throw new Error(
          `Absolute target path "${target}" is not allowed unless the working directory is the filesystem root. Use a relative path or run with -w ${fsRoot}.`,
        );
      }
      if (target.endsWith('/') || target.endsWith(path.sep)) {
        return path.resolve(target, relPath);
      }
      return target;
    }
    if (target.endsWith('/') || target.endsWith(path.sep)) {
      resolved = path.resolve(workingDir, target, relPath);
    } else {
      resolved = path.resolve(workingDir, target);
    }
  } else {
    resolved = path.resolve(workingDir, relPath);
  }

  assertWithinWorkingDir(resolved, workingDir);
  return resolved;
}

function assertWithinWorkingDir(
  resolvedPath: string,
  workingDir: string,
): void {
  const prefix = workingDir.endsWith(path.sep)
    ? workingDir
    : workingDir + path.sep;
  if (resolvedPath !== workingDir && !resolvedPath.startsWith(prefix)) {
    throw new Error(
      `Target path "${resolvedPath}" escapes working directory "${workingDir}".`,
    );
  }
}
