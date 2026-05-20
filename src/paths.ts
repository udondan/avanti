import * as os from 'os';
import * as path from 'path';
import { FileEntry, Variables } from './types';
import { buildFileVars, resolveVars } from './variables';

export function resolveTargetPath(
  entry: { target?: string },
  relPath: string,
  workingDir: string,
  vars: Variables = Object.create(null) as Variables,
): string {
  let resolved: string;
  const target = entry.target ? resolveVars(entry.target, vars) : undefined;

  if (target) {
    if (target.startsWith('~/')) {
      const home = os.homedir();
      const expanded = path.resolve(home, target.slice(2));
      const homePrefix = home.endsWith(path.sep) ? home : home + path.sep;
      if (expanded !== home && !expanded.startsWith(homePrefix)) {
        throw new Error(
          `Target path "${expanded}" escapes home directory "${home}".`,
        );
      }
      if (target.endsWith('/') || target.endsWith(path.sep)) {
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

// Build pre-fetch vars for a file entry: merges per-file path vars into the
// global vars when the entry has a fixed (non-directory) target path. Used by
// pull, diff, and lock so that $path/$filename/etc. are available in source
// URLs and conditions before the fetch happens.
export function buildEntryPreVars(
  entry: FileEntry,
  isSelf: boolean,
  workingDir: string,
  vars: Variables,
): Variables {
  if (isSelf || !entry.target) return vars;
  try {
    const resolvedTargetStr = resolveVars(entry.target, vars);
    if (
      !resolvedTargetStr.endsWith('/') &&
      !resolvedTargetStr.endsWith(path.sep)
    ) {
      const fixedTarget = resolveTargetPath(entry, '', workingDir, vars);
      return Object.assign(
        Object.create(null) as Variables,
        vars,
        buildFileVars(fixedTarget),
      );
    }
  } catch {
    // target unresolvable — leave preVars as global vars
  }
  return vars;
}

export function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return match[1]
    .split(',')
    .flatMap((alt) => expandBraces(prefix + alt + suffix));
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
