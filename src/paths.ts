import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileEntry, Variables } from './types';
import { buildFileVars, resolveVars } from './variables';

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

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
      const homeResolved =
        target.endsWith('/') || target.endsWith(path.sep)
          ? path.resolve(expanded, relPath)
          : expanded;
      assertWithinWorkingDir(homeResolved, workingDir);
      return homeResolved;
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
  while (stack.length > 0) {
    const p = stack.pop()!;
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

// Windows paths are case-insensitive and may use either slash style.
function normalizePath(p: string): string {
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\').toLowerCase();
  }
  return p;
}

function assertWithinWorkingDir(
  resolvedPath: string,
  workingDir: string,
): void {
  const normResolved = normalizePath(resolvedPath);
  const normWorkingDir = normalizePath(workingDir);
  const prefix = normWorkingDir.endsWith(path.sep)
    ? normWorkingDir
    : normWorkingDir + path.sep;
  if (normResolved !== normWorkingDir && !normResolved.startsWith(prefix)) {
    throw new Error(
      `Target path "${resolvedPath}" escapes working directory "${workingDir}".`,
    );
  }
}

// When followSymlink is true and targetPath is a symlink, resolves it to the
// real file and verifies the real file is inside the working directory.
// Returns targetPath unchanged when followSymlink is false/undefined, when the
// path doesn't exist yet, or when the path is not a symlink.
export function resolveFollowSymlink(
  targetPath: string,
  entry: { followSymlink?: boolean },
  workingDir: string,
): string {
  if (!entry.followSymlink) return targetPath;
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) return targetPath;
  // Normalize workingDir to its canonical path so the prefix check is stable
  // on platforms where the working directory is itself reached via a symlink
  // (e.g. macOS /var/folders → /private/var/folders).
  const realWorkingDir = fs.realpathSync(workingDir);
  // Fast path: realpathSync resolves the entire chain atomically. It throws
  // ENOENT when any component is missing (dangling symlink chain), in which
  // case we fall through to manual resolution below.
  try {
    const resolved = fs.realpathSync(targetPath);
    if (fs.lstatSync(resolved).isDirectory()) {
      throw new Error(
        `followSymlink: "${targetPath}" resolves to a directory; refusing to write`,
      );
    }
    assertWithinWorkingDir(resolved, realWorkingDir);
    return resolved;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(
        `followSymlink: "${targetPath}" contains a circular symlink`,
        { cause: err },
      );
    }
    if (code !== 'ENOENT') throw err;
  }
  // Dangling symlink chain — follow links manually until we reach the
  // non-existent endpoint (or detect a cycle).
  let current = targetPath;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) {
      throw new Error(
        `followSymlink: "${targetPath}" contains a circular symlink`,
      );
    }
    seen.add(current);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) break; // non-existent endpoint
    if (!st.isSymbolicLink()) break; // regular file/dir — stop here
    const linkTarget = fs.readlinkSync(current);
    current = path.resolve(path.dirname(current), linkTarget);
  }
  // Canonicalize the deepest existing ancestor directory to catch intermediate
  // symlinked dirs that redirect writes outside the working directory even when
  // the raw string path appears inside it (e.g. workingDir/out -> /etc).
  let dir = path.dirname(current);
  for (;;) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
      const realDir = fs.realpathSync(dir);
      assertWithinWorkingDir(realDir, realWorkingDir);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  assertWithinWorkingDir(current, realWorkingDir);
  return current;
}
