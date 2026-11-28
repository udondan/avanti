/** Batched privileged delete, read and stat operations, one worker call per sudo identity. */
import * as path from 'path';
import type { WorkerResult, WriteOp } from '../privileged-worker';
import { errorMessage } from './errors';
import { runPrivilegedWorker } from './run-worker';
import type { SudoWorkerSession } from './sudo-session';
import type { SudoIdentity } from './types';
import { addToGroup, crashSentinel } from './worker-results';

type Sessions = Map<SudoIdentity, SudoWorkerSession>;

// Returns the session for sudo. If a sessions map was provided but this
// identity is absent, it means openPrivilegedSessions omitted it — surface as
// a bug rather than silently re-prompting via runPrivilegedWorker.
export function requireSession(
  sessions: Sessions | undefined,
  sudo: SudoIdentity,
  caller: string,
): SudoWorkerSession | undefined {
  const session = sessions?.get(sudo);
  if (sessions !== undefined && !session) {
    throw new Error(
      `no privileged session for sudo identity "${String(sudo)}"; ensure openPrivilegedSessions is called before ${caller}`,
    );
  }
  return session;
}

// Runs ops with continueOnError=true through the session, or — without a
// session — through a one-shot spawnSync call. The no-session fallback bypasses
// the single-prompt guarantee; only used by callers that skip
// openPrivilegedSessions.
async function runOps(
  sudo: SudoIdentity,
  session: SudoWorkerSession | undefined,
  ops: WriteOp[],
  timeoutMs?: number,
): Promise<WorkerResult[]> {
  if (!session) return runPrivilegedWorker(sudo, ops, true);
  if (timeoutMs === undefined) return session.exec(ops, true);
  return session.exec(ops, true, timeoutMs);
}

// Scale timeout with batch size: 2 s per op keeps large batches (e.g.
// 50 × 2 MiB files or 20+ lstatFailed paths on slow/encrypted filesystems)
// from timing out. The 30 s minimum covers small batches and one-off checks.
function batchTimeoutMs(opCount: number): number {
  return Math.max(30_000, opCount * 2_000);
}

// Batches privileged deletions into one worker invocation per sudo identity.
// Returns the set of paths that were successfully deleted.
// When bestEffort is false (default), worker-level failures throw; individual
// per-path failures also throw. When bestEffort is true, both are warned and
// the partial success set is returned — used by pull's stale-file cleanup.
export async function sudoAtomicDelete(
  deletions: Array<[string, true | string]>,
  bestEffort = false,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<Set<string>> {
  const succeeded = new Set<string>();
  if (deletions.length === 0) return succeeded;
  // Track per-sudo ordered path lists to correlate results with paths.
  const groups = new Map<SudoIdentity, string[]>();
  for (const [p, sudo] of deletions) {
    addToGroup(groups, sudo, p);
  }
  for (const [sudo, paths] of groups) {
    try {
      await deleteGroup(sudo, paths, bestEffort, sessions, succeeded);
    } catch (err) {
      if (!bestEffort) throw err;
      console.warn(
        `Warning: privileged deletion worker failed: ${errorMessage(err)}`,
      );
    }
  }
  return succeeded;
}

async function deleteGroup(
  sudo: SudoIdentity,
  paths: string[],
  bestEffort: boolean,
  sessions: Sessions | undefined,
  succeeded: Set<string>,
): Promise<void> {
  const ops: WriteOp[] = paths.map((p) => ({
    type: 'delete',
    targetPath: p,
  }));
  const session = requireSession(sessions, sudo, 'sudoAtomicDelete');
  const results = await runOps(sudo, session, ops);
  const failed: string[] = [];
  // Iterate paths (not results) to avoid an off-by-one when continueOnError
  // appends a crash sentinel (N+1 results for N ops). paths[i] is always
  // defined; results[i] may be the sentinel and must be bounds-checked.
  paths.forEach((p, i) => {
    const r = results[i];
    if (r?.ok) {
      succeeded.add(p);
    } else if (bestEffort) {
      console.warn(
        `Warning: privileged operation failed: ${r?.error ?? 'unknown error'}`,
      );
    } else {
      failed.push(`${p}: ${r?.error ?? 'unknown error'}`);
    }
  });
  if (failed.length > 0) {
    throw new Error(`privileged deletion failed:\n${failed.join('\n')}`);
  }
}

type ReadType = 'stat-read' | 'read' | 'readlink';
type ReadEntry = { contentB64: string; isSymlink?: boolean } | null;

// Error codes that a privileged read maps to "no content" (null):
// ENOENT: absent. EACCES/EPERM: worker cannot read the file (e.g. named-user
// cannot traverse a parent directory) — treat as null so the pull proceeds.
// EISDIR/ENOTREGFILE: path exists but is not a regular file or symlink
// (e.g. a directory or special file) — no v0 content to capture, so treat as
// null rather than aborting the pull.
const NULL_READ_CODES = new Set<string | undefined>([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTREGFILE',
]);

// Batches multiple privileged reads into a single worker invocation per
// sudo identity, so pre-write idempotency checks and v0 history captures
// for unreadable files all share one sudo prompt with the subsequent writes.
// Returns a Map keyed by the original filePath values.
export async function sudoAtomicRead(
  reads: Array<{
    filePath: string;
    sudo: true | string;
    type?: 'stat-read' | 'read' | 'readlink';
  }>,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<Map<string, { contentB64: string; isSymlink?: boolean } | null>> {
  const resultMap = new Map<string, ReadEntry>();
  if (reads.length === 0) return resultMap;

  // Group by sudo identity.
  const groups = new Map<
    SudoIdentity,
    Array<{ filePath: string; type: ReadType; idx: number }>
  >();
  reads.forEach((r, idx) => {
    addToGroup(groups, r.sudo, {
      filePath: r.filePath,
      type: r.type ?? 'read',
      idx,
    });
  });

  for (const [sudo, items] of groups) {
    const ops: WriteOp[] = items.map((item) => ({
      type: item.type,
      targetPath: path.resolve(item.filePath),
    }));
    // Worker-level failure (e.g. build missing, JSON parse error, OOM) must
    // propagate: silently falling back to null would skip v0 history capture
    // for every file in the batch, permanently breaking revert/reset without
    // any user-visible error.
    const session = requireSession(sessions, sudo, 'sudoAtomicRead');
    const results = await runOps(
      sudo,
      session,
      ops,
      batchTimeoutMs(ops.length),
    );
    items.forEach((item, i) => {
      resultMap.set(item.filePath, toReadEntry(item.filePath, results[i]));
    });
    // When continueOnError is true, runPrivilegedWorker appends a crash sentinel
    // (N+1 results for N ops) when the worker exits non-zero after completing all
    // ops. The forEach above iterates items (length N), so the sentinel at index N
    // is never visited. Detect and surface it so callers are not left with a
    // complete-looking result map that silently followed an abnormal worker exit.
    const sentinel = crashSentinel(results, items.length);
    if (sentinel) {
      throw new Error(
        `privileged reader crashed after completing all ops: ${sentinel.error ?? 'unknown'}`,
      );
    }
  }

  return resultMap;
}

function toReadEntry(filePath: string, r: WorkerResult | undefined): ReadEntry {
  if (r?.ok && r.contentB64 != null) {
    return { contentB64: r.contentB64, isSymlink: r.isSymlink };
  }
  if (r && !r.ok && !NULL_READ_CODES.has(r.code)) {
    // Non-absence, non-permission, non-type errors (e.g. file too large)
    // must not be silently treated as missing — the write would proceed
    // without capturing v0 content, risking data loss.
    throw new Error(`privileged read of ${filePath} failed: ${r.error}`);
  }
  return null;
}

interface SudoStatEntry {
  exists: boolean;
  isSymlink: boolean;
  isDirectory: boolean;
  /** true for FIFOs, sockets, and device nodes — must not be overwritten */
  isSpecialFile: boolean;
  mode?: string;
  /** base64-encoded file or symlink-target content from the stat-read op */
  contentB64?: string;
}

// Batches stat-read ops for paths whose parent directory is not searchable
// (lstatFailed). Each stat-read result tells us: does the path exist, is it a
// symlink, is it a directory, and what is its current mode (regular files only)?
// Uses the session when available so no extra sudo process is spawned. Replaces
// the per-file sudoFileExists / sudoIsSymlink / sudoIsDirectory helpers (each
// of which spawns a separate sudo process).
export async function sudoStatBatch(
  targets: Array<{ filePath: string; sudo: true | string }>,
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<Map<string, SudoStatEntry>> {
  const result = new Map<string, SudoStatEntry>();
  if (targets.length === 0) return result;

  // Group by sudo identity.
  const groups = new Map<SudoIdentity, Array<{ filePath: string }>>();
  targets.forEach((t) => {
    addToGroup(groups, t.sudo, { filePath: t.filePath });
  });

  for (const [sudo, items] of groups) {
    const ops: WriteOp[] = items.map((item) => ({
      type: 'stat-read' as const,
      targetPath: path.resolve(item.filePath),
    }));
    const session = requireSession(sessions, sudo, 'sudoStatBatch');
    const results = await runOps(
      sudo,
      session,
      ops,
      batchTimeoutMs(ops.length),
    );
    items.forEach((item, j) => {
      result.set(item.filePath, toStatEntry(item.filePath, results[j]));
    });
    // When continueOnError is true, runPrivilegedWorker appends a crash
    // sentinel (N+1 results for N ops) when the worker exits non-zero after
    // completing all ops. The forEach above iterates items (length N), so the
    // sentinel at index N is never visited. Detect and surface it so callers
    // are not left with a complete-looking result map that silently followed
    // an abnormal worker exit.
    const sentinel = crashSentinel(results, items.length);
    if (sentinel) {
      throw new Error(
        `privileged stat-reader crashed after completing all ops: ${sentinel.error ?? 'unknown'}`,
      );
    }
  }
  return result;
}

// Failure codes of a stat-read that still describe the path: a directory, a
// special file, or an absent path.
const EXPECTED_STAT_CODES: Array<string | undefined> = [
  'EISDIR',
  'ENOTREGFILE',
  'ENOENT',
];

function failedWith(
  r: WorkerResult | undefined,
  ...codes: Array<string | undefined>
): boolean {
  return !!r && !r.ok && codes.includes(r.code);
}

function toStatEntry(
  filePath: string,
  r: WorkerResult | undefined,
): SudoStatEntry {
  const isDirectory = failedWith(r, 'EISDIR');
  const isSpecialFile = failedWith(r, 'ENOTREGFILE');
  // EACCES/EPERM: named-user worker cannot traverse a parent directory.
  // Treat as non-existent (exists=false) so the pull proceeds — same
  // behaviour as sudoAtomicRead which maps these to null. The worker's
  // checkAncestorsSafeAsRoot re-validates ancestry at write time.
  if (failedWith(r, 'EACCES', 'EPERM')) {
    return {
      exists: false,
      isSymlink: false,
      isDirectory: false,
      isSpecialFile: false,
      mode: r?.mode,
      contentB64: undefined,
    };
  }
  // Unexpected error codes (EIO, ESTALE, EREMOTE, …) must not be silently
  // mapped to exists=false: that would treat the target as a new file and
  // skip v0 capture, permanently breaking `avanti revert` with no warning.
  if (r && !r.ok && !EXPECTED_STAT_CODES.includes(r.code)) {
    throw new Error(
      `stat-read failed for ${filePath}: ${r.error ?? r.code ?? 'unknown error'}`,
    );
  }
  return {
    exists: !!(r?.ok || isDirectory || isSpecialFile),
    isSymlink: !!(r?.ok && r.isSymlink === true),
    isDirectory,
    isSpecialFile,
    mode: r?.mode,
    contentB64: r?.contentB64,
  };
}
