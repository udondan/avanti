import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { rethrowUnlessAccessDenied, type FileDiff } from './types';

type Stats = NonNullable<ReturnType<typeof fs.lstatSync>>;

function changedSymlinkDiff(
  targetPath: string,
  extra: Partial<FileDiff>,
): FileDiff {
  return {
    targetPath,
    isNew: false,
    hasChanges: true,
    contentChanged: true,
    patch: '',
    ...extra,
    isSymlink: true,
  };
}

/** Build a new-symlink FileDiff without reading disk. Used when lstatFailed
 *  initially but sudo confirms the path does not yet exist — calling
 *  computeSymlinkDiff again would still EACCES on the parent directory. */
export function buildNewSymlinkDiff(
  targetPath: string,
  symlinkTarget: string,
): FileDiff {
  const patch = createTwoFilesPatch(
    '/dev/null',
    targetPath,
    '',
    `-> ${symlinkTarget}\n`,
    '',
    'new symlink',
  );
  return {
    targetPath,
    isNew: true,
    hasChanges: true,
    contentChanged: true,
    patch,
    isSymlink: true,
  };
}

function replaceNonSymlinkDiff(
  targetPath: string,
  symlinkTarget: string,
  stat: Stats,
): FileDiff {
  if (stat.isDirectory()) {
    // Symlinks cannot replace existing directories — write will fail.
    // Return a diff marked isDirectory so callers can surface an error
    // rather than attempting a write that will fail with EISDIR.
    return {
      ...changedSymlinkDiff(targetPath, {}),
      isDirectory: true,
    };
  }
  const existingLabel = stat.isFile() ? 'regular file' : 'special file';
  const patch = createTwoFilesPatch(
    targetPath,
    targetPath,
    `[${existingLabel}]\n`,
    `-> ${symlinkTarget}\n`,
    `was ${existingLabel}`,
    'replaced by symlink',
  );
  return changedSymlinkDiff(targetPath, { patch });
}

function retargetSymlinkDiff(
  targetPath: string,
  symlinkTarget: string,
): FileDiff {
  let currentTarget: string;
  try {
    currentTarget = fs.readlinkSync(targetPath);
  } catch (err) {
    rethrowUnlessAccessDenied(err);
    return changedSymlinkDiff(targetPath, { isUnreadable: true });
  }

  if (currentTarget === symlinkTarget) {
    return {
      targetPath,
      isNew: false,
      hasChanges: false,
      contentChanged: false,
      patch: '',
      isSymlink: true,
    };
  }

  const patch = createTwoFilesPatch(
    targetPath,
    targetPath,
    `-> ${currentTarget}\n`,
    `-> ${symlinkTarget}\n`,
    'symlink target changed',
    'symlink target changed',
  );
  return changedSymlinkDiff(targetPath, { patch });
}

export function computeSymlinkDiff(
  targetPath: string,
  symlinkTarget: string,
): FileDiff {
  let stat: Stats | undefined;
  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (err) {
    rethrowUnlessAccessDenied(err);
    return changedSymlinkDiff(targetPath, {
      isUnreadable: true,
      lstatFailed: true,
    });
  }

  if (stat === undefined) {
    return buildNewSymlinkDiff(targetPath, symlinkTarget);
  }
  if (!stat.isSymbolicLink()) {
    return replaceNonSymlinkDiff(targetPath, symlinkTarget, stat);
  }
  return retargetSymlinkDiff(targetPath, symlinkTarget);
}
