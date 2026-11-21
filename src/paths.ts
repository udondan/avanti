import * as os from 'os';
import * as path from 'path';
import { FileEntry, Variables } from './types';
import { buildFileVars, resolveVars } from './variables';
import { assertWithinWorkingDir } from './paths/guard';

export { resolveFollowSymlink } from './paths/symlink';

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function endsWithSep(p: string): boolean {
  return p.endsWith('/') || p.endsWith(path.sep);
}

function resolveHomeTarget(target: string, relPath: string): string {
  const home = os.homedir();
  const expanded = path.resolve(home, target.slice(2));
  const homePrefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (expanded !== home && !expanded.startsWith(homePrefix)) {
    throw new Error(
      `Target path "${expanded}" escapes home directory "${home}".`,
    );
  }
  return endsWithSep(target) ? path.resolve(expanded, relPath) : expanded;
}

function resolveTarget(
  target: string | undefined,
  relPath: string,
  workingDir: string,
): string {
  if (!target) return path.resolve(workingDir, relPath);
  if (target.startsWith('~/')) return resolveHomeTarget(target, relPath);
  if (path.isAbsolute(target)) {
    return endsWithSep(target)
      ? path.resolve(target, relPath)
      : path.resolve(target);
  }
  return endsWithSep(target)
    ? path.resolve(workingDir, target, relPath)
    : path.resolve(workingDir, target);
}

export function resolveTargetPath(
  entry: { target?: string },
  relPath: string,
  workingDir: string,
  vars: Variables = Object.create(null) as Variables,
): string {
  const target = entry.target ? resolveVars(entry.target, vars) : undefined;
  const resolved = resolveTarget(target, relPath, workingDir);
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
    if (!endsWithSep(resolvedTargetStr)) {
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

export function expandBraces(pattern: string, limit = 100): string[] {
  // Require a comma inside the braces — {foo} without a comma is left literal,
  // matching bash behaviour and avoiding accidental expansion of filenames like
  // {param} that some frameworks use.
  //
  // Iterative DFS (explicit stack) avoids call-stack overflow for patterns
  // with many brace groups. Alternatives are pushed in reverse so that
  // pop() processes them left-to-right, preserving natural ordering.
  const results: string[] = [];
  const stack = [pattern];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    const match = /\{([^{}]*,[^{}]*)\}/.exec(p);
    if (!match) {
      results.push(p);
      if (results.length > limit) {
        throw new Error(`brace expansion exceeds ${limit} entries`);
      }
      continue;
    }
    const prefix = p.slice(0, match.index);
    const suffix = p.slice(match.index + match[0].length);
    const alts = match[1].split(',');
    if (results.length + stack.length + alts.length > limit) {
      throw new Error(`brace expansion exceeds ${limit} entries`);
    }
    for (let i = alts.length - 1; i >= 0; i--) {
      stack.push(prefix + alts[i] + suffix);
    }
  }
  return results;
}
