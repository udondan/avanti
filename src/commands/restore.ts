/**
 * Shared restore logic of `avanti revert` and `avanti reset`: planning which
 * tracked files to rewrite or delete, and applying that plan atomically.
 */
import { computeDiff, computeDeleteDiff, computeSymlinkDiff } from '../diff';
import type { FileDiff } from '../diff';
import type { HistoryManager } from '../history';
import type { FileHistoryMeta } from '../history/types';
import {
  atomicWrite,
  AtomicWritePartialError,
  closeAllSessions,
  openPrivilegedSessions,
  sudoAtomicDelete,
  sudoAtomicWrite,
  SudoWorkerSession,
  SudoWritePartialError,
  SudoWriteTarget,
  WriteTarget,
} from '../writer';
import { confirm } from '../prompt';

export interface RestorePlan {
  writeTargets: WriteTarget[];
  deletions: string[];
  sudoDeletions: Map<string, true | string>;
  diffs: FileDiff[];
  hasError: boolean;
}

/** What a restored symlink is called in the Windows error message. */
type SymlinkKind = 'symlink' | 'pre-avanti symlink';

interface RestoreMessages {
  /** Verb used in the partial-failure warning, e.g. "revert". */
  action: string;
  /** Past tense used in the Windows sudo warning, e.g. "reverted". */
  pastTense: string;
  /** Prefix of the failure message, e.g. "Revert failed". */
  failurePrefix: string;
  /** Printed after all files were written. */
  success: string;
}

interface ApplyContext {
  plan: RestorePlan;
  sudoTargets: SudoWriteTarget[];
  sessions: Map<true | string, SudoWorkerSession>;
  messages: RestoreMessages;
  // Set to true once sudoAtomicWrite returns without throwing so the catch
  // block can warn about sudo files already on disk when atomicWrite fails.
  sudoWriteComplete: boolean;
}

export function createRestorePlan(): RestorePlan {
  return {
    writeTargets: [],
    deletions: [],
    sudoDeletions: new Map<string, true | string>(),
    diffs: [],
    hasError: false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function planSymlinkRestore(
  plan: RestorePlan,
  meta: FileHistoryMeta,
  content: Buffer,
  kind: SymlinkKind,
): void {
  if (process.platform === 'win32') {
    console.error(
      `symlink: ${meta.absolutePath}: cannot restore ${kind} on Windows`,
    );
    plan.hasError = true;
    return;
  }
  const symlinkTarget = content.toString('utf8');
  const d = computeSymlinkDiff(meta.absolutePath, symlinkTarget);
  if (d.isDirectory) {
    console.error(
      `symlink: ${meta.absolutePath} is a directory; cannot restore symlink over directory`,
    );
    plan.hasError = true;
    plan.diffs.push(d);
  } else if (d.hasChanges) {
    plan.writeTargets.push({
      targetPath: meta.absolutePath,
      content,
      symlinkTarget,
      sudo: meta.sudo,
    });
    plan.diffs.push(d);
  }
}

/**
 * Plans restoring `content` (a stored version) to the tracked file. `kind` is
 * set when the stored version is a symlink target.
 */
export function planVersionRestore(
  plan: RestorePlan,
  meta: FileHistoryMeta,
  content: Buffer,
  kind: SymlinkKind | undefined,
): void {
  if (kind !== undefined) {
    planSymlinkRestore(plan, meta, content, kind);
    return;
  }
  const d = computeDiff(meta.absolutePath, content);
  if (d.hasChanges) {
    plan.writeTargets.push({
      targetPath: meta.absolutePath,
      content,
      sudo: meta.sudo,
    });
    plan.diffs.push(d);
  }
}

/**
 * Plans returning the tracked file to its pre-avanti state: restore `v0` when
 * the file existed before avanti, otherwise delete it.
 */
export function planPreAvantiRestore(
  plan: RestorePlan,
  history: HistoryManager,
  meta: FileHistoryMeta,
): void {
  if (meta.existedBeforeAvanti) {
    const original = history.readVersion(meta.absolutePath, 0);
    if (original === null) return;
    const kind = meta.v0IsSymlink ? 'pre-avanti symlink' : undefined;
    planVersionRestore(plan, meta, original, kind);
    return;
  }
  const d = computeDeleteDiff(meta.absolutePath);
  if (!d.hasChanges) return;
  if (meta.sudo) {
    plan.sudoDeletions.set(meta.absolutePath, meta.sudo);
  } else {
    plan.deletions.push(meta.absolutePath);
  }
  plan.diffs.push(d);
}

/** Asks for confirmation unless `yes` is set; exits with 0 when declined. */
export async function confirmApply(yes: boolean | undefined): Promise<void> {
  if (yes ?? false) return;
  const ok = await confirm('Apply? [y/N] ');
  if (!ok) {
    console.log('Aborted.');
    process.exit(0);
  }
}

function openSessions(
  sudoIds: Set<true | string>,
): Map<true | string, SudoWorkerSession> {
  let sudoSessions: Map<true | string, SudoWorkerSession> = new Map();
  try {
    sudoSessions = openPrivilegedSessions(sudoIds);
  } catch (err) {
    console.error(errorMessage(err));
    closeAllSessions(sudoSessions);
    process.exit(2);
  }
  return sudoSessions;
}

async function applyPrivileged(ctx: ApplyContext): Promise<void> {
  const { sudoTargets, plan, sessions } = ctx;
  // Perform privileged operations first: if sudo fails, the
  // unprivileged writes have not yet happened, keeping the project in a
  // consistent (if incomplete) state.
  if (process.platform !== 'win32') {
    if (sudoTargets.length > 0) {
      await sudoAtomicWrite(sudoTargets, [], sessions);
      ctx.sudoWriteComplete = true;
    }
    if (plan.sudoDeletions.size > 0)
      await sudoAtomicDelete([...plan.sudoDeletions], false, sessions);
  } else if (sudoTargets.length > 0 || plan.sudoDeletions.size > 0) {
    const n = sudoTargets.length + plan.sudoDeletions.size;
    console.warn(
      `Warning: ${n} privileged file(s) were not ${ctx.messages.pastTense} — sudo is not supported on Windows.`,
    );
  }
}

// Determine which paths were successfully written before the failure.
// Case (a): SudoWritePartialError — err.writtenPaths lists confirmed writes.
// Case (b): sudoWriteComplete + AtomicWritePartialError — sudoAtomicWrite
//           succeeded; err.writtenPaths lists regular files already renamed.
// Case (c): sudoWriteComplete + plain Error — sudoAtomicWrite succeeded,
//           atomicWrite failed before any rename; only sudo targets are on disk.
function writtenBeforeFailure(
  err: unknown,
  ctx: ApplyContext,
): string[] | null {
  if (err instanceof SudoWritePartialError) return err.writtenPaths;
  if (ctx.sudoWriteComplete) {
    return [
      ...ctx.sudoTargets.map((t) => t.targetPath),
      ...(err instanceof AtomicWritePartialError ? err.writtenPaths : []),
    ];
  }
  if (err instanceof AtomicWritePartialError) return err.writtenPaths;
  return null;
}

function reportFailure(err: unknown, ctx: ApplyContext): void {
  const writtenPaths = writtenBeforeFailure(err, ctx);
  if (writtenPaths !== null && writtenPaths.length > 0) {
    console.warn(
      `Warning: partial ${ctx.messages.action} — the following ${writtenPaths.length} file(s) were written before the failure:`,
    );
    for (const p of writtenPaths) {
      console.warn(`  ${p}`);
    }
    // History is intentionally NOT updated here. A subsequent run will
    // recompute diffs against the target state; files already at the
    // target state will show no diff and be skipped automatically, making
    // the retry idempotent without any history bookkeeping.
  }
  console.error(`${ctx.messages.failurePrefix}: ${errorMessage(err)}`);
}

/**
 * Writes and deletes everything in `plan`: privileged operations first, then
 * one atomic write for the rest. Sets exit code 2 on failure.
 */
export async function applyRestorePlan(
  plan: RestorePlan,
  messages: RestoreMessages,
): Promise<void> {
  const isSudoTarget = (t: WriteTarget): t is SudoWriteTarget => !!t.sudo;
  const regularTargets = plan.writeTargets.filter((t) => !t.sudo);
  const sudoTargets = plan.writeTargets.filter(isSudoTarget);

  // Create one shared session per sudo identity so that sudoAtomicWrite
  // and sudoAtomicDelete share a single worker process (one password
  // prompt total, regardless of timestamp_timeout).
  const sudoIds = new Set<true | string>([
    ...sudoTargets.map((t) => t.sudo),
    ...plan.sudoDeletions.values(),
  ]);
  const sessions = openSessions(sudoIds);
  const ctx: ApplyContext = {
    plan,
    sudoTargets,
    sessions,
    messages,
    sudoWriteComplete: false,
  };

  try {
    await applyPrivileged(ctx);
    atomicWrite(regularTargets, plan.deletions);
    console.log(messages.success);
  } catch (err: unknown) {
    reportFailure(err, ctx);
    process.exitCode = 2;
  } finally {
    closeAllSessions(sessions);
  }
}
