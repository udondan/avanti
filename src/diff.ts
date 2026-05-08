import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { Variables } from './types';
import { resolveVars } from './variables';

export interface FileDiff {
  targetPath: string;
  isNew: boolean;
  hasChanges: boolean;
  patch: string;
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  if (!fs.existsSync(targetPath)) {
    return { targetPath, isNew: false, hasChanges: false, patch: '' };
  }
  const oldContent = fs.readFileSync(targetPath, 'utf8');
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

export function computeDiff(targetPath: string, newContent: string): FileDiff {
  const isNew = !fs.existsSync(targetPath);
  const oldContent = isNew ? '' : fs.readFileSync(targetPath, 'utf8');

  const hasChanges = oldContent !== newContent;

  const patch = createTwoFilesPatch(
    isNew ? '/dev/null' : targetPath,
    targetPath,
    oldContent,
    newContent,
    isNew ? '' : undefined,
    isNew ? 'new file' : undefined,
  );

  return { targetPath, isNew, hasChanges, patch };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';

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
    if (path.isAbsolute(target)) {
      if (workingDir !== '/') {
        throw new Error(
          `Absolute target path "${target}" is not allowed when working directory is not "/". Use a relative path or run with -w /.`,
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
