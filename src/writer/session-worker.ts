/** Spawning, describing and terminating the sudo process behind a worker session. */
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import type { SudoIdentity } from './types';
import { SUDO_PRESERVE_NONCE_ARG, sudoUserArgs } from './worker-staging';

interface SessionWorkerSpec {
  sudo: SudoIdentity;
  nodeExec: string;
  workerPath: string;
  socketPath: string;
  nonce: string;
}

// Open /dev/tty so that sudo can look up cached credentials via
// ttyname(STDIN_FILENO). When stdin is a pipe, macOS sudo's ttyname()
// returns NULL and ignores the credential cache, forcing a re-prompt.
// Fall back to 'inherit' when no controlling TTY is available (CI, containers).
function openControllingTty(): number | undefined {
  try {
    return fs.openSync('/dev/tty', 'r+');
  } catch {
    /* no controlling TTY */
    return undefined;
  }
}

export function spawnSessionWorker(spec: SessionWorkerSpec): ChildProcess {
  const ttyFd = openControllingTty();
  try {
    return spawn(
      'sudo',
      [
        // Forward AVANTI_WORKER_NONCE from the parent env to the worker.
        // This requires the invoking user's sudoers entry to allow setenv
        // (i.e. not have !setenv). If denied, sudo exits non-zero before the
        // worker starts and exec() rejects via the proc.on('close') handler.
        SUDO_PRESERVE_NONCE_ARG,
        ...sudoUserArgs(spec.sudo),
        spec.nodeExec,
        spec.workerPath,
        `--socket-path=${spec.socketPath}`,
      ],
      {
        // Pass the nonce via env so it does not appear in /proc/<pid>/cmdline
        // (world-readable on Linux). /proc/<pid>/environ is owner-readable only.
        env: { ...process.env, AVANTI_WORKER_NONCE: spec.nonce },
        // stdin: /dev/tty (or inherited) so sudo's ttyname() succeeds
        // stdout/stderr: ignored — all IPC goes through the Unix socket
        stdio: [ttyFd ?? 'inherit', 'ignore', 'inherit'],
        // detached: sudo becomes a new process group leader so that
        // close() can kill the entire group (-pid) including the node
        // worker child on platforms where sudo forks rather than exec()s
        // (e.g. macOS with PAM). The inherited /dev/tty fd on stdin still
        // reaches sudo for password prompts even in the new session.
        detached: true,
      },
    );
  } finally {
    if (ttyFd !== undefined) {
      try {
        fs.closeSync(ttyFd);
      } catch {
        // ignore
      }
    }
  }
}

// Error for the readiness gate after the sudo process exited.
export function workerExitReadyMessage(
  connected: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const phase = connected ? 'after connecting' : 'before connecting';
  if (code !== null) {
    const outcome = connected ? 'crashed' : 'failed';
    return `privileged worker ${outcome} ${phase} (exit ${code})`;
  }
  return `privileged worker killed ${phase} (signal ${signal ?? 'unknown'})`;
}

// Error for an exec() that was in flight when the sudo process exited.
export function workerExitPendingMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (code === 0) {
    return 'privileged worker exited unexpectedly with no response';
  }
  if (code !== null) return `privileged worker failed (exit ${code})`;
  return `privileged worker killed (signal ${signal ?? 'unknown'})`;
}

export function terminateWorker(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  // Kill the entire process group: sudo was spawned with detached:true so
  // it is the process group leader. -pid targets both sudo and its node
  // worker child (on macOS where sudo forks rather than exec()s). On Linux
  // sudo typically exec()s so proc.pid == worker pid and -pid == proc.pid.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process group may already be gone; fall back to direct kill.
    proc.kill('SIGTERM');
  }
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore; process group likely already gone
    }
  }, 5_000);
  t.unref();
  proc.once('close', () => clearTimeout(t));
}
