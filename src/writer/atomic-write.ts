/** Unprivileged multi-file write: stage everything, back up, then rename into place. */
import * as fs from 'fs';
import { writeInPlace } from './atomic-in-place';
import {
  assertInPlaceTargetsNotSymlinks,
  createBackups,
  stageFile,
  stageSymlink,
  type StagedFile,
  type StagedLink,
  type SymlinkWriteTarget,
} from './atomic-stage';
import { AtomicWritePartialError, errorMessage } from './errors';
import { removeQuietly } from './fs-utils';
import type { WriteTarget } from './types';

function isSymlinkTarget(t: WriteTarget): t is SymlinkWriteTarget {
  return t.symlinkTarget !== undefined;
}

export function atomicWrite(
  targets: WriteTarget[],
  deletions: string[] = [],
): void {
  // Stage each file as a sibling temp file on the same filesystem as the
  // destination so that renameSync (rename(2)) is atomic on POSIX.
  const symlinkTargets = targets.filter(isSymlinkTarget);
  const regularTargets = targets.filter((t) => t.symlinkTarget === undefined);
  const mvTargets = regularTargets.filter((t) => !t.writeInPlace);
  const inPlaceTargets = regularTargets.filter((t) => t.writeInPlace);

  // Symlinks and mv-target files both use a stage-then-rename approach so
  // no destination path is touched until ALL staging AND backup work is done.
  const staged: StagedFile[] = [];
  // Staged temp symlinks — renamed into place in Phase 3 alongside mv targets.
  const stagedLinks: StagedLink[] = [];
  const backupTemps: string[] = [];
  try {
    // Phase 0 (symlink staging): create temp symlinks but do NOT rename yet.
    // Renames happen in Phase 3, after backups have captured the pre-write state.
    if (symlinkTargets.length > 0 && process.platform === 'win32') {
      throw new Error('symlink writes are not supported on Windows');
    }
    for (const t of symlinkTargets) {
      stagedLinks.push(stageSymlink(t));
    }

    // Phase 1 (mv targets): write all temp files. Backups are deferred to
    // Phase 2 so that a staging failure here never creates an orphaned backup
    // for a destination that hasn't been modified yet.
    // In-place targets skip this phase (no temp file); their backups are still
    // created in Phase 2. If Phase 4 fails after open (which truncates the
    // file), the destination may be empty or partially written — the backup
    // captures the pre-write content and can be used for recovery.
    for (const t of mvTargets) {
      stageFile(t, staged);
    }

    assertInPlaceTargetsNotSymlinks(inPlaceTargets);

    // Phase 2: all staging succeeded — now create backups.
    createBackups(targets, backupTemps);

    commit(stagedLinks, staged, inPlaceTargets);
  } finally {
    removeQuietly(stagedLinks.map((s) => s.tmp));
    removeQuietly(backupTemps);
    removeQuietly(staged.map((s) => s.tmp));
  }

  // Deletions happen after writes succeed; each failure is non-fatal
  for (const p of deletions) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.warn(`Warning: could not delete ${p}: ${errorMessage(err)}`);
    }
  }
}

// Phase 3: atomically rename all staged temps (files and symlinks) into place.
// Only now are destination paths modified — all staging and backups succeeded.
// Track each successful rename so AtomicWritePartialError can report which
// files actually landed on disk if the loop fails mid-batch.
function commit(
  stagedLinks: StagedLink[],
  staged: StagedFile[],
  inPlaceTargets: WriteTarget[],
): void {
  const writtenPaths: string[] = [];
  try {
    for (const s of stagedLinks) {
      fs.renameSync(s.tmp, s.dest);
      writtenPaths.push(s.dest);
    }
    for (const s of staged) {
      // Mode was applied to the temp-file inode via fchmodSync before close —
      // rename(2) carries the inode with its permissions, so no path-based
      // chmod is needed here (which would reopen a TOCTOU window).
      fs.renameSync(s.tmp, s.dest);
      writtenPaths.push(s.dest);
    }

    // Phase 4: in-place writes — preserve inode, not atomic
    for (const t of inPlaceTargets) {
      writeInPlace(t, writtenPaths);
    }
  } catch (phaseErr) {
    // Re-wrap as AtomicWritePartialError so callers (e.g. pull.ts catch block)
    // can tell which destination files actually landed on disk.
    throw new AtomicWritePartialError(errorMessage(phaseErr), writtenPaths);
  }
}
