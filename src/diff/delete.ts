import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { isBinary } from '../binary';
import { rethrowUnlessAccessDenied, type FileDiff } from './types';

type DeleteRead = { diff: FileDiff } | { content: Buffer };

function deletedDiff(targetPath: string, extra: Partial<FileDiff>): FileDiff {
  return {
    targetPath,
    isNew: false,
    isDelete: true,
    hasChanges: true,
    contentChanged: true,
    patch: '',
    ...extra,
  };
}

function symlinkDeleteDiff(targetPath: string): FileDiff {
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(targetPath);
  } catch (err) {
    rethrowUnlessAccessDenied(err);
    // Symlink exists but reading its target requires elevated privileges.
    return deletedDiff(targetPath, { isUnreadable: true, isSymlink: true });
  }
  const patch = createTwoFilesPatch(
    targetPath,
    '/dev/null',
    `-> ${linkTarget}\n`,
    '',
    undefined,
    'deleted',
  );
  return deletedDiff(targetPath, { patch, isSymlink: true });
}

function readForDelete(targetPath: string): DeleteRead {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat === undefined) {
    return {
      diff: {
        targetPath,
        isNew: false,
        hasChanges: false,
        contentChanged: false,
        patch: '',
      },
    };
  }
  if (stat.isSymbolicLink()) {
    return { diff: symlinkDeleteDiff(targetPath) };
  }
  return { content: fs.readFileSync(targetPath) };
}

function deleteErrorDiff(targetPath: string, err: unknown): FileDiff {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    // Dangling symlink — lstatSync saw the symlink but readFileSync followed
    // it to a non-existent target. Treat as a binary delete (no diff available).
    return deletedDiff(targetPath, { isBinary: true });
  }
  rethrowUnlessAccessDenied(err);
  // File exists but is unreadable (e.g. root-owned 0600).
  return deletedDiff(targetPath, { isUnreadable: true });
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  let read: DeleteRead;
  try {
    read = readForDelete(targetPath);
  } catch (err) {
    return deleteErrorDiff(targetPath, err);
  }
  if ('diff' in read) return read.diff;
  const oldBuf = read.content;
  if (isBinary(oldBuf)) {
    return deletedDiff(targetPath, { isBinary: true });
  }
  const oldContent = oldBuf.toString('utf8');
  const patch = createTwoFilesPatch(
    targetPath,
    '/dev/null',
    oldContent,
    '',
    undefined,
    'deleted',
  );
  return {
    targetPath,
    isNew: false,
    hasChanges: true,
    contentChanged: true,
    patch,
  };
}
