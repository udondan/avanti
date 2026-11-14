/** Helpers for interpreting privileged worker result arrays. */
import type { WorkerResult } from '../privileged-worker';
import type { SudoIdentity } from './types';

// Clamps results to opCount and pads unprocessed tail ops so callers always
// receive exactly opCount results and can tell completed ops from those that
// never ran.
export function padResults(
  results: WorkerResult[],
  opCount: number,
): WorkerResult[] {
  const padded = results.slice(0, opCount);
  while (padded.length < opCount) {
    padded.push({
      ok: false,
      error: 'worker exited before processing this op',
    });
  }
  return padded;
}

// With continueOnError, a worker that exits non-zero after completing all ops
// appends one extra {ok:false} entry (N+1 results for N ops). Returns that
// sentinel when present.
export function crashSentinel(
  results: WorkerResult[],
  opCount: number,
): WorkerResult | undefined {
  if (results.length <= opCount) return undefined;
  const sentinel = results[opCount];
  return sentinel && !sentinel.ok ? sentinel : undefined;
}

// Appends value to the slice at groups[key], creating it if absent.
// Deduplicates the group-by-sudo-identity pattern used across batch functions.
export function addToGroup<V>(
  groups: Map<SudoIdentity, V[]>,
  key: SudoIdentity,
  value: V,
): void {
  const existing = groups.get(key);
  if (existing) existing.push(value);
  else groups.set(key, [value]);
}
