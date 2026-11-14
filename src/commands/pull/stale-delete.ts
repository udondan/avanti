/** Deletes stale files, unprivileged and through sudo worker sessions. */
import * as fs from 'fs';
import type { WriteOp, WorkerResult } from '../../privileged-worker';
import { errorMessage } from './common';
import { abortWithSessions } from './sudo-sessions';
import { PullRun } from './types';

/** Outcome of stale cleanup, used to prune history refs. */
export interface CleanupProgress {
  effectivelyDeleted: Set<string>;
  /**
   * Tracks all stale paths fully resolved this pull — including no-ops
   * (file already gone, or already matches v0). Used to prune old refs
   * from history so stale cleanup does not repeat on subsequent pulls.
   */
  effectivelyCleaned: Set<string>;
}

function warnDeleteFailed(p: string, reason: string): void {
  console.warn(`Warning: could not delete ${p}: ${reason}`);
}

export function deleteRegularStale(
  run: PullRun,
  progress: CleanupProgress,
): void {
  const stale = run.stale;
  for (const { path: p, sudo, diffIndex } of stale.toDelete) {
    if (sudo) continue;
    if (!stale.diffs[diffIndex].hasChanges) {
      // File is already gone — no-op, but still clean up its history ref.
      progress.effectivelyCleaned.add(p);
      continue;
    }
    try {
      fs.rmSync(p, { force: true });
      progress.effectivelyDeleted.add(p);
      progress.effectivelyCleaned.add(p);
    } catch (err) {
      warnDeleteFailed(p, errorMessage(err));
    }
  }
}

function recordDeleteResults(
  paths: string[],
  results: WorkerResult[],
  progress: CleanupProgress,
): void {
  for (const [di, result] of results.slice(0, paths.length).entries()) {
    if (result.ok) {
      // A skipped delete means the file was already absent — clean up its
      // history ref so we don't re-attempt the deletion on every pull.
      if (!result.skipped) progress.effectivelyDeleted.add(paths[di]);
      progress.effectivelyCleaned.add(paths[di]);
    } else if (result.error) {
      warnDeleteFailed(paths[di], result.error);
    }
  }
  // Crash sentinel: the worker appends an extra result at index
  // paths.length when it exits non-zero mid-batch (continueOnError).
  const crashSentinel = results[paths.length];
  if (crashSentinel && !crashSentinel.ok) {
    console.warn(
      `Warning: privileged worker crashed during stale-file cleanup: ${crashSentinel.error ?? 'worker exited unexpectedly'}`,
    );
  }
}

async function deleteWithSession(
  run: PullRun,
  sv: true | string,
  paths: string[],
  progress: CleanupProgress,
): Promise<void> {
  const session = run.sessions.get(sv);
  if (!session) {
    // Phase 2 opens a session for every identity in deferredIds,
    // which includes all identities that reach this deletion loop.
    // A missing session means Phase 2 has a bug — surface it loudly
    // rather than masking it with a silent fallback invocation.
    throw new Error(
      `no privileged session for sudo identity "${String(sv)}" during stale-file cleanup`,
    );
  }
  const deleteOps: WriteOp[] = paths.map((p) => ({
    type: 'delete' as const,
    targetPath: p,
  }));
  // Stale cleanup is best-effort: a session-level failure (worker
  // crash, auth error) is treated as a warning, not a fatal error.
  let deleteResults: WorkerResult[];
  try {
    deleteResults = await session.exec(deleteOps, true);
  } catch (sessionErr) {
    for (const p of paths) warnDeleteFailed(p, errorMessage(sessionErr));
    return;
  }
  recordDeleteResults(paths, deleteResults, progress);
}

export async function deleteSudoStale(
  run: PullRun,
  progress: CleanupProgress,
): Promise<void> {
  const stale = run.stale;
  // Group by sudo identity; use the pre-created session
  const byDeleteId = new Map<true | string, string[]>();
  for (const { path: p, sudo: sv, diffIndex } of stale.toDelete) {
    if (!sv) continue;
    if (!stale.diffs[diffIndex].hasChanges) {
      // File is already gone — no-op, but still clean up its history ref.
      progress.effectivelyCleaned.add(p);
      continue;
    }
    const paths = byDeleteId.get(sv) ?? [];
    paths.push(p);
    byDeleteId.set(sv, paths);
  }
  try {
    for (const [sv, paths] of byDeleteId) {
      await deleteWithSession(run, sv, paths, progress);
    }
  } catch (cleanupErr: unknown) {
    abortWithSessions(
      run,
      'Privileged stale-file cleanup failed: ',
      cleanupErr,
    );
  }
}
