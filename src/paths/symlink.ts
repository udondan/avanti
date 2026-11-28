import * as fs from 'fs';
import * as path from 'path';
import { assertWithinWorkingDir, normalizePath } from './guard';

// Fast path: realpathSync resolves the entire chain atomically. It throws
// ENOENT when any component is missing (dangling symlink chain), in which
// case undefined is returned so the caller falls back to manual resolution.
function resolveExistingChain(
  targetPath: string,
  realWorkingDir: string,
): string | undefined {
  try {
    const resolved = fs.realpathSync(targetPath);
    if (fs.lstatSync(resolved).isDirectory()) {
      throw new Error(
        `followSymlink: "${targetPath}" resolves to a directory; refusing to write`,
      );
    }
    try {
      assertWithinWorkingDir(resolved, realWorkingDir);
    } catch {
      throw new Error(
        `followSymlink: "${targetPath}" resolves to "${resolved}" which escapes the working directory`,
      );
    }
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
    return undefined;
  }
}

// Dangling symlink chain — follow links manually until we reach the
// non-existent endpoint (or detect a cycle).
function followToEndpoint(targetPath: string): string {
  let current = targetPath;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(normalizePath(current))) {
      throw new Error(
        `followSymlink: "${targetPath}" contains a circular symlink`,
      );
    }
    seen.add(normalizePath(current));
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) return current; // non-existent endpoint
    if (!st.isSymbolicLink()) return current; // regular file/dir — stop here
    const linkTarget = fs.readlinkSync(current);
    current = path.resolve(path.dirname(current), linkTarget);
  }
}

// Canonicalize the deepest existing ancestor directory to catch intermediate
// symlinked dirs that redirect writes outside the working directory even when
// the raw string path appears inside it (e.g. workingDir/out -> /etc).
function canonicalizeAncestor(
  targetPath: string,
  current: string,
  realWorkingDir: string,
): string {
  let dir = path.dirname(current);
  for (;;) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
      const realDir = fs.realpathSync(dir);
      try {
        assertWithinWorkingDir(realDir, realWorkingDir);
      } catch {
        throw new Error(
          `followSymlink: "${targetPath}" escapes the working directory via a symlinked intermediate directory`,
        );
      }
      // Rewrite current using the canonical ancestor so that the final prefix
      // check compares apples-to-apples. Without this, macOS /var/… paths
      // fail the /private/var/… prefix check even when the path is valid.
      return path.join(realDir, path.relative(dir, current));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return current; // reached filesystem root
    dir = parent;
  }
}

function resolveDanglingChain(
  targetPath: string,
  realWorkingDir: string,
): string {
  const endpoint = followToEndpoint(targetPath);
  const current = canonicalizeAncestor(targetPath, endpoint, realWorkingDir);
  try {
    assertWithinWorkingDir(current, realWorkingDir);
  } catch {
    throw new Error(
      `followSymlink: "${targetPath}" escapes the working directory`,
    );
  }
  return current;
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
  return (
    resolveExistingChain(targetPath, realWorkingDir) ??
    resolveDanglingChain(targetPath, realWorkingDir)
  );
}
