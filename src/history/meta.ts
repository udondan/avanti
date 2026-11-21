import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile } from './storage';
import type { FileHistoryMeta } from './types';

/** Inputs for capturing a file's pre-avanti content as `v0`. */
interface OriginalCaptureInput {
  targetPath: string;
  fileDir: string;
  isSymlink?: boolean;
  v0Override?: Buffer;
  v0IsSymlinkOverride?: boolean;
}

interface OriginalState {
  existedBeforeAvanti: boolean;
  v0IsSymlink: boolean;
}

interface FirstSeenInput extends OriginalCaptureInput {
  slug: string;
  isNew: boolean;
}

interface LoadedMeta {
  meta: FileHistoryMeta;
  isFirstSeen: boolean;
  isSymlinkChanged: boolean;
}

const RECOVERABLE_CAPTURE_CODES: ReadonlyArray<string | undefined> = [
  'EACCES',
  'EPERM',
  'ENOENT',
];

/**
 * Reads the current content at `targetPath`. A symlink is captured as its
 * target string. Returns null when a symlink entry finds neither a symlink nor
 * a regular file at the path.
 */
function readOriginal(
  targetPath: string,
  isSymlink: boolean | undefined,
): { content: Buffer; isSymlink: boolean } | null {
  // For a symlink entry, capture the previous symlink target (if any) rather
  // than the content of the file it points to. Even when the new entry is a
  // regular file, the path may already hold a symlink. Use lstat so we capture
  // the symlink itself (not the bytes it points to) and set v0IsSymlink
  // accordingly — this lets reset/revert faithfully restore the pre-avanti
  // symlink.
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    return {
      content: Buffer.from(fs.readlinkSync(targetPath), 'utf8'),
      isSymlink: true,
    };
  }
  if (isSymlink && !stat?.isFile()) return null;
  return { content: fs.readFileSync(targetPath), isSymlink: false };
}

function recoverFromCaptureError(
  err: unknown,
  input: OriginalCaptureInput,
  state: OriginalState,
): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (!RECOVERABLE_CAPTURE_CODES.includes(code)) {
    throw err;
  }
  if (input.v0Override !== undefined) {
    fs.writeFileSync(path.join(input.fileDir, 'v0'), input.v0Override);
    if (input.v0IsSymlinkOverride) state.v0IsSymlink = true;
  } else if (code === 'ENOENT') {
    // Dangling symlink: lstatSync saw the symlink but readFileSync
    // followed it to a missing target. No usable original content
    // existed, so don't claim the file predated avanti — stale cleanup
    // will delete the avanti-written file rather than warn-and-leave.
    state.existedBeforeAvanti = false;
  }
  // EACCES/EPERM without override: file exists but is unreadable. Keep
  // existedBeforeAvanti=true so stale cleanup warns and leaves the file
  // rather than deleting it (safer than destroying an unreadable file).
}

/** Saves the pre-avanti content of an existing file as `v0`. */
function captureOriginal(input: OriginalCaptureInput): OriginalState {
  const state: OriginalState = {
    existedBeforeAvanti: true,
    v0IsSymlink: false,
  };
  try {
    const original = readOriginal(input.targetPath, input.isSymlink);
    if (original === null) {
      state.existedBeforeAvanti = false;
      return state;
    }
    state.v0IsSymlink = original.isSymlink;
    fs.writeFileSync(path.join(input.fileDir, 'v0'), original.content);
  } catch (err) {
    recoverFromCaptureError(err, input, state);
  }
  return state;
}

/** Builds the meta of a file staged for the first time, capturing `v0`. */
function initFirstSeenMeta(input: FirstSeenInput): FileHistoryMeta {
  const { existedBeforeAvanti, v0IsSymlink } = input.isNew
    ? { existedBeforeAvanti: false, v0IsSymlink: false }
    : captureOriginal(input);
  return {
    absolutePath: input.targetPath,
    slug: input.slug,
    firstSeenAt: new Date().toISOString(),
    existedBeforeAvanti,
    currentVersion: 0,
    ...(input.isSymlink ? { isSymlink: true } : {}),
    ...(v0IsSymlink ? { v0IsSymlink: true } : {}),
  };
}

/**
 * Loads the meta at `metaPath` (updating `isSymlink` in memory) or initialises
 * it for a first-seen file.
 */
export function loadMetaForStaging(
  metaPath: string,
  input: FirstSeenInput,
): LoadedMeta {
  if (!fs.existsSync(metaPath)) {
    return {
      meta: initFirstSeenMeta(input),
      isFirstSeen: true,
      isSymlinkChanged: false,
    };
  }
  const meta = readJsonFile<FileHistoryMeta>(metaPath);
  // Update isSymlink in memory only; persist after the version file write
  // so that meta.json is never ahead of committed history if the pull aborts.
  const newIsSymlink = input.isSymlink ? true : undefined;
  const isSymlinkChanged = meta.isSymlink !== newIsSymlink;
  if (isSymlinkChanged) meta.isSymlink = newIsSymlink;
  return { meta, isFirstSeen: false, isSymlinkChanged };
}

/**
 * Creates the directory and minimal meta for a file that was never staged,
 * saving its current content as `v0` when it exists.
 */
export function createMinimalMeta(
  fileDir: string,
  slug: string,
  targetPath: string,
): FileHistoryMeta {
  fs.mkdirSync(fileDir, { recursive: true });
  const existedBeforeAvanti = fs.existsSync(targetPath);
  if (existedBeforeAvanti) {
    fs.writeFileSync(path.join(fileDir, 'v0'), fs.readFileSync(targetPath));
  }
  return {
    absolutePath: targetPath,
    slug,
    firstSeenAt: new Date().toISOString(),
    existedBeforeAvanti,
    currentVersion: 0,
  };
}
