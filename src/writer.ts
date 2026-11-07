/**
 * Writing pulled files to disk: unprivileged atomic writes, and privileged
 * (sudo) writes, deletes, reads and stats through the privileged worker.
 */
export type {
  SudoChmodTarget,
  SudoWriteTarget,
  WriteTarget,
} from './writer/types';
export {
  checkNodeVersion,
  NODE_VERSION_CHECK_TIMEOUT_MS,
  resolveNodeExec,
  type NodeVersionCheck,
} from './writer/node-exec';
export { sudoUserArgs } from './writer/worker-staging';
export {
  AtomicWritePartialError,
  PartialWriteError,
  SudoWritePartialError,
} from './writer/errors';
export { sudoAtomicWrite } from './writer/sudo-write';
export {
  sudoAtomicDelete,
  sudoAtomicRead,
  sudoStatBatch,
} from './writer/sudo-batch';
export {
  closeAllSessions,
  openPrivilegedSessions,
  SudoWorkerSession,
} from './writer/sudo-session';
export { atomicWrite } from './writer/atomic-write';
