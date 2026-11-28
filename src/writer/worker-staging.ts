/** Locating, staging and launching the compiled privileged worker. */
import * as fs from 'fs';
import * as path from 'path';
import { resolveNodeExec } from './node-exec';
import { stagedWorkerDirs } from './registry';
import { WORLD_TMP } from './world-tmp';

// Forwards only the worker nonce through sudo. `-E` would forward the whole
// environment, but sudo-rs (the default sudo since Ubuntu 26.04) ignores it.
export const SUDO_PRESERVE_NONCE_ARG = '--preserve-env=AVANTI_WORKER_NONCE';

// Name of the worker entry script and of the directory holding its compiled
// helper modules, both next to each other in dist/.
const WORKER_ENTRY = 'privileged-worker.js';
const WORKER_HELPER_DIR = 'privileged-worker';

export function sudoUserArgs(sudo: true | string): string[] {
  return typeof sudo === 'string' ? ['-u', sudo] : [];
}

// Resolves the compiled privileged-worker.js path and throws if it does not
// exist (i.e. the user forgot to run `mise run build`). Cached: __dirname and
// __filename are constant for the process lifetime so the path never changes.
let _cachedWorkerPath: string | undefined;
function resolveWorkerPath(): string {
  if (_cachedWorkerPath !== undefined) return _cachedWorkerPath;
  const fromSource = __filename.endsWith('.ts');
  const workerPath = fromSource
    ? path.resolve(__dirname, '..', '..', 'dist', WORKER_ENTRY)
    : path.join(__dirname, '..', WORKER_ENTRY);
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `privileged worker not found at ${workerPath}` +
        (fromSource ? '; run `mise run build` first' : ''),
    );
  }
  _cachedWorkerPath = workerPath;
  return workerPath;
}

// Cache of staged worker binaries keyed on the source workerPath. Multiple
// named-user sessions for different identities share one copy so the binary
// is not copied redundantly within a process lifetime. The tmpDir stays alive
// until process exit (tracked in stagedWorkerDirs); sessions do NOT clean it
// up on close() — they each own their own per-session ipcDir instead.
const _workerStagingCache = new Map<string, string>();

// Copies src to a fresh path inside a private staging dir and makes it
// read-only for everyone.
function copyReadOnly(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o444);
}

// Copies the compiled helper modules of the worker (every regular *.js file
// directly inside srcDir) into destDir. Symlinks and sub-directories are not
// followed. Does nothing when srcDir is not a directory.
function stageWorkerHelpers(srcDir: string, destDir: string): void {
  if (!fs.lstatSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) return;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  fs.mkdirSync(destDir, { mode: 0o700 });
  // Same as the staging dir: traversable for the named sudo user, not listable.
  fs.chmodSync(destDir, 0o711);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    copyReadOnly(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
}

// Copies the privileged-worker script to a world-readable temp directory so
// that `sudo -u <user>` can reach and exec it regardless of the calling user's
// home-directory permissions. Its helper modules are copied alongside into a
// sub-directory. Returns the staged path; the tmpDir is owned by the module
// (tracked in stagedWorkerDirs) and lives until process exit.
function stageWorkerForSudo(workerPath: string): string {
  const cached = _workerStagingCache.get(workerPath);
  if (cached !== undefined) return cached;
  // mkdtemp(2) is POSIX-specified to create with mode S_IRWXU (0700) regardless
  // of the caller's umask, so no umask manipulation is required here.
  const tmpDir = fs.mkdtempSync(path.join(WORLD_TMP, 'avanti-worker-'));
  try {
    // Chmod to 0o711: the named sudo user needs to traverse and exec the script
    // but must not be able to list the directory contents.
    fs.chmodSync(tmpDir, 0o711);
    const stagedPath = path.join(tmpDir, WORKER_ENTRY);
    copyReadOnly(workerPath, stagedPath);
    stageWorkerHelpers(
      path.join(path.dirname(workerPath), WORKER_HELPER_DIR),
      path.join(tmpDir, WORKER_HELPER_DIR),
    );
    stagedWorkerDirs.add(tmpDir); // tracked for process-exit cleanup
    _workerStagingCache.set(workerPath, stagedPath);
    return stagedPath;
  } catch (e) {
    // Clean up immediately on staging failure; do not rely solely on process-
    // exit cleanup since a retry loop would accumulate orphaned directories.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

// Shared setup for both runPrivilegedWorker (one-shot spawnSync) and
// SudoWorkerSession (persistent spawn): resolves the worker script path and
// the node executable to invoke via sudo, staging the binary to a world-
// readable temp dir for named-user sudo. The staged dir is owned by the
// module (process-exit cleanup), NOT the caller.
export function prepareWorkerExec(sudo: true | string): {
  nodeExec: string;
  resolvedWorkerPath: string;
} {
  const workerPath = resolveWorkerPath();
  const nodeExec = resolveNodeExec(sudo);
  if (typeof sudo === 'string') {
    return {
      nodeExec,
      resolvedWorkerPath: stageWorkerForSudo(workerPath),
    };
  }
  return { nodeExec, resolvedWorkerPath: workerPath };
}

export const _testable = { stageWorkerForSudo };
