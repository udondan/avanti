/** Batched privileged writes and chmods, one worker call per sudo identity. */
import type { WorkerResult, WriteOp } from '../privileged-worker';
import { checkAncestorsSafe } from './dir-safety';
import { errorMessage, SudoWritePartialError } from './errors';
import { runPrivilegedWorker } from './run-worker';
import { requireSession } from './sudo-batch';
import type { SudoWorkerSession } from './sudo-session';
import { buildTrustedUids } from './trusted-uids';
import type { SudoChmodTarget, SudoIdentity, SudoWriteTarget } from './types';
import { addToGroup, crashSentinel } from './worker-results';

// Each target is written atomically inside the privileged worker process, but
// the batch is NOT collectively atomic: a failure mid-way leaves earlier targets
// already written. All targets sharing the same sudo identity are dispatched in
// a single worker invocation — one sudo password prompt per distinct identity.
// chmodTargets are batched into the same per-identity invocation as the writes
// so that a pull with both content changes and mode-only changes for the same
// sudo identity still produces exactly one prompt.
// Returns the count of chmod ops that were actually applied (ENOENT/ELOOP skips
// are not counted). Throws SudoWritePartialError (not plain Error) when writes
// fail mid-batch so callers can inspect writtenPaths and record partial history.
export async function sudoAtomicWrite(
  targets: SudoWriteTarget[],
  chmodTargets: SudoChmodTarget[] = [],
  sessions?: Map<true | string, SudoWorkerSession>,
): Promise<number> {
  if (targets.length === 0 && chmodTargets.length === 0) return 0;

  const defaultMode = (0o666 & ~currentUmask()).toString(8).padStart(4, '0');

  // Hoist UID lookup: buildTrustedUids spawns `id -u <user>` — dedupe per
  // identity and reuse session.trustedUids when a session already holds them.
  const trustedUidsBySudo = new Map<SudoIdentity, Set<number>>();
  const allSudoIds = new Set<SudoIdentity>([
    ...targets.map((t) => t.sudo),
    ...chmodTargets.map((t) => t.sudo),
  ]);
  for (const sudoId of allSudoIds) {
    trustedUidsBySudo.set(
      sudoId,
      sessions?.get(sudoId)?.trustedUids ?? buildTrustedUids(sudoId),
    );
  }

  // Validate ancestor safety for all targets before any privileged work.
  // checkAncestorsSafe prefers lstatSync (0 sudo calls) for world-readable
  // paths like /usr/local/bin; sudo stat is only used for unreadable ancestors.
  // Chmod targets share the checked-dirs set so dirs already validated for
  // write targets are not rechecked.
  const ancestorCheck = new AncestorCheck(trustedUidsBySudo);
  for (const t of targets) {
    ancestorCheck.check(t.sudo, t.targetPath, 'destination');
    if (t.backupPath) {
      ancestorCheck.check(t.sudo, t.backupPath, 'backup');
    }
  }
  for (const t of chmodTargets) {
    ancestorCheck.check(t.sudo, t.targetPath, 'destination');
  }

  // Group ops into separate per-identity write and chmod maps so the dispatch
  // loop never slices by count. Using two maps eliminates the implicit ordering
  // invariant (write ops must precede chmod ops in a shared array) that a future
  // refactor could silently violate.
  const writeGroups = new Map<SudoIdentity, WriteOp[]>();
  const chmodGroups = new Map<SudoIdentity, WriteOp[]>();
  for (const t of targets) {
    addToGroup(writeGroups, t.sudo, buildWriteOp(t, defaultMode));
  }
  for (const t of chmodTargets) {
    const op: WriteOp = {
      type: 'chmod',
      targetPath: t.targetPath,
      mode: t.mode,
    };
    addToGroup(chmodGroups, t.sudo, op);
  }

  // Collect all sudo identities that have either write or chmod ops.
  const sudoIds = new Set<SudoIdentity>([
    ...writeGroups.keys(),
    ...chmodGroups.keys(),
  ]);

  let chmodApplied = 0;
  const writtenPaths: string[] = [];
  for (const sudo of sudoIds) {
    const writeOps = writeGroups.get(sudo) ?? [];
    const chmodOps = chmodGroups.get(sudo) ?? [];
    const session = requireSession(sessions, sudo, 'sudoAtomicWrite');
    if (writeOps.length > 0) {
      await applyWriteOps(sudo, session, writeOps, writtenPaths);
    }
    if (chmodOps.length > 0) {
      chmodApplied += await applyChmodOps(sudo, session, chmodOps);
    }
  }
  return chmodApplied;
}

// Reads the process umask. Passing a mask and restoring it is what the
// deprecated no-argument process.umask() does internally.
function currentUmask(): number {
  const mask = process.umask(0);
  process.umask(mask);
  return mask;
}

// Ancestor-safety checks for one batch, remembering per sudo identity which
// directories were already validated.
class AncestorCheck {
  private readonly checkedDirsBySudo = new Map<SudoIdentity, Set<string>>();

  constructor(
    private readonly trustedUidsBySudo: Map<SudoIdentity, Set<number>>,
  ) {}

  check(sudo: SudoIdentity, targetPath: string, label: string): void {
    let checkedDirs = this.checkedDirsBySudo.get(sudo);
    if (!checkedDirs) {
      checkedDirs = new Set();
      this.checkedDirsBySudo.set(sudo, checkedDirs);
    }
    checkAncestorsSafe(
      targetPath,
      this.trustedUidsBySudo.get(sudo),
      label,
      checkedDirs,
    );
  }
}

// Encode content as base64 in the JSON payload — no temp files needed.
// This works for any sudo identity (root, named user) since the data travels
// over stdin and the worker never touches the caller's filesystem.
function buildWriteOp(t: SudoWriteTarget, defaultMode: string): WriteOp {
  if (t.symlinkTarget !== undefined) {
    return {
      type: 'write-symlink',
      targetPath: t.targetPath,
      symlinkTarget: t.symlinkTarget,
      backupPath: t.backupPath,
    };
  }
  return {
    type: t.writeInPlace ? 'write-in-place' : 'write-mv',
    targetPath: t.targetPath,
    contentB64: t.content.toString('base64'),
    mode: t.mode,
    defaultMode,
    backupPath: t.backupPath,
  };
}

async function applyWriteOps(
  sudo: SudoIdentity,
  session: SudoWorkerSession | undefined,
  writeOps: WriteOp[],
  writtenPaths: string[],
): Promise<void> {
  const writeResults = await execWriteOps(
    sudo,
    session,
    writeOps,
    writtenPaths,
  );
  let writeError: string | null = null;
  for (let wi = 0; wi < writeOps.length; wi++) {
    const r = writeResults[wi];
    if (r?.ok) {
      writtenPaths.push(writeOps[wi].targetPath);
    } else if (r && !r.ok && writeError === null) {
      writeError = r.error ?? 'privileged worker op failed';
    }
  }
  // Crash sentinel: when continueOnError=true and the worker exits non-zero,
  // runPrivilegedWorker always appends a (N+1)th sentinel with ok:false.
  // For the session path (session.exec), the sentinel only appears when all
  // N ops returned ok:true (crash-after-completion). For the spawnSync path,
  // it is appended unconditionally on any non-zero exit.
  // Only set writeError from the sentinel when no per-op failure was found —
  // that case means all N writes landed on disk and the crash happened after.
  // When a per-op error already set writeError, the sentinel just reflects the
  // non-zero exit caused by that per-op failure and adds no new information.
  if (writeError === null) {
    const sentinel = crashSentinel(writeResults, writeOps.length);
    if (sentinel) {
      writeError = `privileged worker crashed after completing all write ops: ${sentinel.error ?? 'unknown'}`;
    }
  }
  if (writeError !== null) {
    throw new SudoWritePartialError(writeError, writtenPaths);
  }
}

async function execWriteOps(
  sudo: SudoIdentity,
  session: SudoWorkerSession | undefined,
  writeOps: WriteOp[],
  writtenPaths: string[],
): Promise<WorkerResult[]> {
  if (!session) {
    // No session: fall back to a one-shot spawnSync call. This bypasses the
    // single-sudo-prompt guarantee (one spawnSync per identity per call) and
    // silently re-prompts if sudo credential caching is disabled. All production
    // callers (pull, reset, revert) open sessions via openPrivilegedSessions;
    // this branch exists for callers that skip session management (e.g. tests).
    return runPrivilegedWorker(sudo, writeOps, true);
  }
  // continueOnError=true: get per-op results even when one write fails so
  // writtenPaths records every file that actually landed on disk.
  try {
    return await session.exec(writeOps, true);
  } catch (sessionErr) {
    // Session-level error (IPC failure, worker killed, socket closed).
    // Writes that completed before the crash may have landed on disk;
    // throw SudoWritePartialError so callers can record partial history.
    throw new SudoWritePartialError(errorMessage(sessionErr), writtenPaths);
  }
}

// Returns the number of chmod ops that were actually applied.
async function applyChmodOps(
  sudo: SudoIdentity,
  session: SudoWorkerSession | undefined,
  chmodOps: WriteOp[],
): Promise<number> {
  const chmodResults = await execChmodOps(sudo, session, chmodOps);
  if (chmodResults === undefined) return 0;
  let chmodApplied = 0;
  let chmodError: string | null = null;
  for (let ci = 0; ci < chmodOps.length; ci++) {
    const r = chmodResults[ci];
    if (!r) break;
    if (r.ok && !r.skipped) chmodApplied++;
    else if (!r.ok) {
      chmodError ??= r.error ?? 'unknown error';
      console.warn(
        `Warning: chmod failed for ${chmodOps[ci].targetPath}: ${r.error ?? 'unknown error'}`,
      );
    }
  }
  // Crash sentinel: fires when continueOnError=true and the worker exits
  // non-zero after all N chmod ops returned successfully. Guard on
  // chmodError === null so the "all ok" message is suppressed when per-op
  // failures exist — for the spawnSync path, runPrivilegedWorker appends
  // the sentinel on ANY non-zero exit regardless of how many ops completed,
  // so the sentinel alone does not mean all ops succeeded.
  const sentinel =
    chmodError === null
      ? crashSentinel(chmodResults, chmodOps.length)
      : undefined;
  if (sentinel) {
    console.warn(
      `Warning: privileged chmod worker crashed after completing all ops: ${sentinel.error ?? 'unknown'}. ` +
        `All files are written with correct content and permissions.`,
    );
  }
  return chmodApplied;
}

// Returns undefined when the session failed; the failure has been reported.
async function execChmodOps(
  sudo: SudoIdentity,
  session: SudoWorkerSession | undefined,
  chmodOps: WriteOp[],
): Promise<WorkerResult[] | undefined> {
  if (!session) {
    // No session: fall back to a one-shot spawnSync call. See execWriteOps.
    return runPrivilegedWorker(sudo, chmodOps, true);
  }
  // continueOnError=true: a chmod failure must not abort subsequent
  // chmod ops in the same batch (e.g. when multiple files have mode drift).
  try {
    return await session.exec(chmodOps, true);
  } catch (chmodSessionErr) {
    // Worker crashed between the write exec() call and this chmod exec()
    // call. The writes are already committed on disk; only permissions are
    // affected. Warn per-file rather than propagating as a write failure.
    const msg = errorMessage(chmodSessionErr);
    for (const co of chmodOps) {
      console.warn(
        `Warning: could not apply chmod to ${co.targetPath}: ${msg}. File content is correct; permissions will re-drift.`,
      );
    }
    return undefined;
  }
}
