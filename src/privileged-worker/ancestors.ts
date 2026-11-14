/** Ownership and permission checks on ancestor directories, run as root. */
import * as fs from 'fs';
import * as path from 'path';
import { errnoCode } from './fs-helpers';

interface DirOwnership {
  mode: number;
  ownerUid: number;
}

function symlinkDirOwnership(
  absDir: string,
  lst: fs.Stats,
  trustedUids: Set<number>,
  label: string,
): DirOwnership {
  let s: fs.Stats;
  try {
    s = fs.statSync(absDir);
  } catch (e2) {
    if (errnoCode(e2) !== 'ENOENT') throw e2;
    // Dangling symlink: the target no longer exists. An attacker who owns
    // the parent directory could atomically replace the symlink with one
    // pointing to an attacker-controlled location after this check (TOCTOU).
    throw new Error(
      `privileged write: ${label} directory ${absDir} is a dangling symlink (TOCTOU risk)`,
      { cause: e2 },
    );
  }
  const targetOwnerUid = s.uid;
  if (!trustedUids.has(targetOwnerUid)) {
    throw new Error(
      `privileged write: ${label} directory ${absDir} symlink target owned by UID ${targetOwnerUid}, not trusted (TOCTOU risk)`,
    );
  }
  return { mode: s.mode & 0o7777, ownerUid: lst.uid };
}

// Returns undefined when absDir does not exist.
function dirOwnership(
  absDir: string,
  trustedUids: Set<number>,
  label: string,
): DirOwnership | undefined {
  try {
    const lst = fs.lstatSync(absDir);
    if (lst.isSymbolicLink()) {
      return symlinkDirOwnership(absDir, lst, trustedUids, label);
    }
    return { mode: lst.mode & 0o7777, ownerUid: lst.uid };
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return undefined;
    throw e;
    // No EACCES early return: the worker runs as root, so any stat failure
    // here is unexpected and should propagate.
  }
}

// Verifies that a directory is safe to use as a mktemp staging location.
// Unlike the caller-side checkDirSafe, this runs inside the privileged worker
// (as root) and therefore never returns early for EACCES — root can lstatSync
// any directory, so EACCES-owned ancestors are validated rather than skipped.
function checkDirSafeAsRoot(
  absDir: string,
  trustedUids: Set<number>,
  label: string,
): void {
  const ownership = dirOwnership(absDir, trustedUids, label);
  if (ownership === undefined) return;
  const { mode, ownerUid } = ownership;

  if (process.platform !== 'win32') {
    const isWritable = !!(mode & 0o022);
    const hasSticky = !!(mode & 0o1000);
    if (isWritable && !hasSticky) {
      throw new Error(
        `privileged write: ${label} directory ${absDir} is group/world-writable without sticky bit (TOCTOU risk)`,
      );
    }
  }

  if (!trustedUids.has(ownerUid)) {
    throw new Error(
      `privileged write: ${label} directory ${absDir} owned by UID ${ownerUid}, not trusted (TOCTOU risk)`,
    );
  }
}

// Collects ancestor directories of targetPath from filesystem root down to the
// immediate parent, then calls callback for each. Mirrored (not shared) by an
// Mirrored verbatim in writer.ts — privileged-worker.ts is a standalone script
// compiled to dist/privileged-worker.js and cannot import from the main source
// tree at runtime. Both copies must remain identical: any edge-case fix (e.g.
// bind-mount, Windows UNC paths, or loop-termination changes) must be applied
// to both. If you change this function, search for its twin in writer.ts and
// update it too. Extracting to a shared module was considered but rejected
// because it changes the compiled output layout for the standalone worker.
function walkAncestors(
  targetPath: string,
  callback: (anc: string) => void,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break;
  }
  for (const ancestor of ancestors) {
    callback(ancestor);
  }
}

export function checkAncestorsSafeAsRoot(
  targetPath: string,
  trustedUids: Set<number>,
  label: string,
  checkedDirs?: Set<string>,
): void {
  walkAncestors(targetPath, (ancestor) => {
    if (checkedDirs?.has(ancestor)) return;
    checkDirSafeAsRoot(ancestor, trustedUids, label);
    checkedDirs?.add(ancestor);
  });
}

/**
 * Creates the parent directory `dir` of resolvedPath (mode 0755, recursive),
 * validating resolvedPath's ancestors before and after when trustedUids is
 * given. Pre-validating catches world-writable ancestors that the caller could
 * not lstat (EACCES); re-validating covers any intermediate directories that
 * mkdirSync itself creates.
 */
export function mkdirWithAncestorChecks(
  resolvedPath: string,
  dir: string,
  trustedUids: Set<number> | undefined,
  label: string,
): void {
  if (trustedUids) checkAncestorsSafeAsRoot(resolvedPath, trustedUids, label);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (trustedUids) checkAncestorsSafeAsRoot(resolvedPath, trustedUids, label);
}
