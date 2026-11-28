import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { isBinary } from '../binary';
import {
  rethrowUnlessAccessDenied,
  type FileDiff,
  type ModeChange,
} from './types';

interface ExistingState {
  isNew: boolean;
  oldBuf: Buffer;
  isUnreadable: boolean;
  lstatFailed: boolean;
}

function existingState(
  isNew: boolean,
  oldBuf: Buffer,
  isUnreadable = false,
): ExistingState {
  return { isNew, oldBuf, isUnreadable, lstatFailed: false };
}

function readExisting(targetPath: string): ExistingState {
  let stat: ReturnType<typeof fs.lstatSync> | undefined;
  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (err) {
    rethrowUnlessAccessDenied(err);
    // lstatSync failed — parent directory not searchable. Existence is unknown;
    // treat as existing (conservative). pull.ts uses sudoAtomicRead to verify
    // the true state through the privileged worker after sessions are opened.
    return {
      isNew: false,
      oldBuf: Buffer.alloc(0),
      isUnreadable: true,
      lstatFailed: true,
    };
  }

  if (stat === undefined) return existingState(true, Buffer.alloc(0));
  try {
    return existingState(false, fs.readFileSync(targetPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Dangling symlink — lstatSync saw the symlink but readFileSync
      // followed it to a non-existent target. Treat as empty content:
      // the diff will show the full new content being written.
      // isUnreadable stays false; oldBuf stays empty Buffer.
      return existingState(false, Buffer.alloc(0));
    }
    rethrowUnlessAccessDenied(err);
    // File exists but is unreadable (e.g. root-owned 0600).
    return existingState(false, Buffer.alloc(0), true);
  }
}

function currentModeChange(
  targetPath: string,
  desired: number,
): ModeChange | undefined {
  try {
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink()) return undefined;
    const current = stat.mode & 0o7777;
    return desired === current ? undefined : { from: current, to: desired };
  } catch (err) {
    rethrowUnlessAccessDenied(err);
    // Cannot stat unreadable file — skip mode detection.
    return undefined;
  }
}

function detectModeChange(
  targetPath: string,
  desiredMode: string | undefined,
): ModeChange | undefined {
  if (!desiredMode || process.platform === 'win32') return undefined;
  const desired = parseInt(desiredMode, 8);
  if (isNaN(desired)) return undefined;
  return currentModeChange(targetPath, desired);
}

function binaryDiff(
  targetPath: string,
  existing: ExistingState,
  newContent: Buffer,
  modeChange: ModeChange | undefined,
): FileDiff {
  const contentChanged = existing.isNew || !newContent.equals(existing.oldBuf);
  const hasChanges = contentChanged || modeChange !== undefined;
  return {
    targetPath,
    isNew: existing.isNew,
    hasChanges,
    contentChanged,
    patch: '',
    isBinary: true,
    modeChange,
  };
}

function textPatch(
  targetPath: string,
  isNew: boolean,
  oldContent: string,
  newText: string,
): string {
  if (isNew) {
    return createTwoFilesPatch(
      '/dev/null',
      targetPath,
      oldContent,
      newText,
      '',
      'new file',
    );
  }
  return createTwoFilesPatch(targetPath, targetPath, oldContent, newText);
}

function textDiff(
  targetPath: string,
  existing: ExistingState,
  newContent: Buffer,
  modeChange: ModeChange | undefined,
): FileDiff {
  const oldContent = existing.oldBuf.toString('utf8');
  const newText = newContent.toString('utf8');
  const contentChanged = oldContent !== newText;
  const hasChanges = contentChanged || modeChange !== undefined;
  const patch = contentChanged
    ? textPatch(targetPath, existing.isNew, oldContent, newText)
    : '';

  return {
    targetPath,
    isNew: existing.isNew,
    hasChanges,
    contentChanged,
    patch,
    modeChange,
  };
}

export function computeDiff(
  targetPath: string,
  newContent: Buffer,
  desiredMode?: string,
): FileDiff {
  const existing = readExisting(targetPath);
  const modeChange = existing.isNew
    ? undefined
    : detectModeChange(targetPath, desiredMode);

  if (existing.isUnreadable) {
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
      ...(existing.lstatFailed && { lstatFailed: true }),
      modeChange,
    };
  }

  if (isBinary(newContent) || isBinary(existing.oldBuf)) {
    return binaryDiff(targetPath, existing, newContent, modeChange);
  }
  return textDiff(targetPath, existing, newContent, modeChange);
}

/** Build a new-file FileDiff from content without reading disk. Used when
 *  lstatFailed initially but sudo confirms the file does not yet exist. */
export function buildNewFileDiff(
  targetPath: string,
  newContent: Buffer,
  modeChange?: ModeChange,
): FileDiff {
  if (isBinary(newContent)) {
    return {
      targetPath,
      isNew: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
      modeChange,
    };
  }
  const newText = newContent.toString('utf8');
  const patch = createTwoFilesPatch(
    '/dev/null',
    targetPath,
    '',
    newText,
    '',
    'new file',
  );
  return {
    targetPath,
    isNew: true,
    hasChanges: true,
    contentChanged: true,
    patch,
    modeChange,
  };
}
