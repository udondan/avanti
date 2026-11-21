/** Request, response and op types of the privileged worker JSON protocol. */

interface WriteFileOpBase {
  targetPath: string;
  contentB64: string;
  mode?: string;
  defaultMode: string;
  backupPath?: string;
}

export interface WriteMvOp extends WriteFileOpBase {
  type: 'write-mv';
}

export interface WriteInPlaceOp extends WriteFileOpBase {
  type: 'write-in-place';
}

export interface WriteSymlinkOp {
  type: 'write-symlink';
  targetPath: string;
  symlinkTarget: string;
  backupPath?: string;
}

export interface DeleteOp {
  type: 'delete';
  targetPath: string;
}

export interface ChmodOp {
  type: 'chmod';
  targetPath: string;
  mode: string;
}

export interface ReadOp {
  type: 'read';
  targetPath: string;
}

export interface ReadlinkOp {
  type: 'readlink';
  targetPath: string;
}

export interface StatReadOp {
  type: 'stat-read';
  targetPath: string;
}

export type WriteOp =
  | WriteMvOp
  | WriteInPlaceOp
  | WriteSymlinkOp
  | DeleteOp
  | ChmodOp
  | ReadOp
  | ReadlinkOp
  | StatReadOp;

export interface WorkerRequest {
  ops: WriteOp[];
  continueOnError?: boolean;
}

export interface WorkerResult {
  ok: boolean;
  error?: string;
  /** errno code from NodeJS.ErrnoException, e.g. 'ENOENT'; set when ok is false */
  code?: string;
  /** true when a chmod op was silently skipped (ENOENT/ELOOP) — not an error */
  skipped?: boolean;
  /** base64-encoded file content, set for read/readlink/stat-read ops */
  contentB64?: string;
  /** true when stat-read resolved a symlink (contentB64 is the link target) */
  isSymlink?: boolean;
  /** octal mode string (e.g. '0644'), set by stat-read for regular files and symlinks */
  mode?: string;
}

export interface WorkerResponse {
  results: WorkerResult[];
}

export type DispatchResult =
  | { kind: 'ok' }
  | { kind: 'skipped' }
  | { kind: 'read'; contentB64: string; isSymlink: boolean; mode?: string };
