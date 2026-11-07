/** Shared state of a write-in-place overwrite of an existing file. */
import type { WriteInPlaceOp } from './types';

export interface InPlaceContext {
  op: WriteInPlaceOp;
  resolvedTarget: string;
  dir: string;
  content: Buffer;
  effectiveMode: string | undefined;
}

// Mutable state read by the failure recovery: which fds are open, the mode
// captured before O_TRUNC, and whether the new content reached the disk.
export interface InPlaceState {
  fd?: number;
  rfd?: number;
  savedMode?: number;
  savedSize?: number;
  writeSucceeded: boolean;
  originalContentForRestore?: Buffer;
}

export function symlinkRefusal(
  targetPath: string,
  options?: ErrorOptions,
): Error {
  return new Error(
    `writeInPlace: ${targetPath} is a symlink; refusing to follow`,
    options,
  );
}

export function notRegularFileRefusal(
  targetPath: string,
  options?: ErrorOptions,
): Error {
  return new Error(
    `writeInPlace: ${targetPath} is not a regular file; refusing to write`,
    options,
  );
}
