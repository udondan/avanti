/** Process-wide registries of staged temp dirs and live sudo sessions. */
import * as fs from 'fs';

/** The part of a live sudo session the signal handlers need. */
interface ClosableSession {
  close(): void;
}

// Use process-level Symbols to store the Sets so that all evaluations of this
// module (e.g. Vitest re-importing between test files) share the exact same
// Set instances. Module-level `const` Sets are re-created on each re-import,
// but the exit/signal handlers (registered only once via _HANDLERS_KEY) capture
// the FIRST evaluation's Sets via closure — new entries added after re-import
// would be invisible to the handlers and leaked on process exit.
const _DIRS_KEY = Symbol.for('avanti.writer.stagedWorkerDirs');
const _SESSIONS_KEY = Symbol.for('avanti.writer.activeSudoSessions');
const _proc = process as unknown as Record<symbol, unknown>;

// Registry of staged worker temp dirs. The 'exit' handler fires on normal exit
// and on explicit process.exit() calls. SIGTERM and SIGINT do NOT trigger
// 'exit' unless a signal handler calls process.exit() first; SIGKILL is
// uninterceptable and cannot be cleaned up.
_proc[_DIRS_KEY] ??= new Set<string>();
export const stagedWorkerDirs = _proc[_DIRS_KEY] as Set<string>;

// Tracks all live SudoWorkerSession instances so signal handlers can close them
// before calling process.exit(1). This prevents write batches from completing
// in the worker after the parent exits and leaving history in an inconsistent state.
_proc[_SESSIONS_KEY] ??= new Set<ClosableSession>();
export const activeSudoSessions = _proc[_SESSIONS_KEY] as Set<ClosableSession>;

// Deregisters dir from stagedWorkerDirs and removes it from disk.
// Called from normal cleanup paths and the process.on('exit') fallback.
export function cleanupWorkerDir(dir: string): void {
  stagedWorkerDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// process.on() suppresses Node's default signal termination, so the handler
// must always call process.exit() — otherwise the process silently absorbs
// SIGINT/SIGTERM when no sessions are active and hangs instead of exiting.
function teardown(signal: string): void {
  const hadSessions = activeSudoSessions.size > 0;
  for (const s of Array.from(activeSudoSessions)) {
    try {
      s.close();
    } catch {
      // best-effort
    }
  }
  // Always use the POSIX signal exit code (128+signum) so shells can
  // distinguish user-abort from a generic error regardless of whether
  // sessions were active. Deferred one tick when sessions were open so
  // Promise rejections from s.close() propagate before the process ends.
  const exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
  if (hadSessions) {
    setImmediate(() => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}

// Module-level flag prevents duplicate handler registration when Vitest
// re-evaluates this module between test files.
const _HANDLERS_KEY = Symbol.for('avanti.writer.exitHandlersRegistered');
if (!_proc[_HANDLERS_KEY]) {
  _proc[_HANDLERS_KEY] = true;
  process.on('exit', () => {
    for (const d of Array.from(stagedWorkerDirs)) {
      cleanupWorkerDir(d);
    }
  });
  process.on('SIGTERM', teardown);
  process.on('SIGINT', teardown);
}
