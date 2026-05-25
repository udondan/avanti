import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { isBinary } from './binary';

export interface FileDiff {
  targetPath: string;
  isNew: boolean;
  isDelete?: boolean;
  hasChanges: boolean;
  contentChanged: boolean;
  patch: string;
  isBinary?: boolean;
  isUnreadable?: boolean;
  /** True when lstatSync threw EACCES/EPERM (parent directory not searchable),
   *  meaning existence cannot be determined without elevated privileges. */
  lstatFailed?: boolean;
  modeChange?: { from: number; to: number };
  isSymlink?: boolean;
}

export function computeDeleteDiff(targetPath: string): FileDiff {
  let oldBuf: Buffer;
  try {
    if (fs.lstatSync(targetPath, { throwIfNoEntry: false }) === undefined) {
      return {
        targetPath,
        isNew: false,
        hasChanges: false,
        contentChanged: false,
        patch: '',
      };
    }
    oldBuf = fs.readFileSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Dangling symlink — lstatSync saw the symlink but readFileSync followed
      // it to a non-existent target. Treat as a binary delete (no diff available).
      return {
        targetPath,
        isNew: false,
        isDelete: true,
        hasChanges: true,
        contentChanged: true,
        patch: '',
        isBinary: true,
      };
    }
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    // File exists but is unreadable (e.g. root-owned 0600).
    return {
      targetPath,
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
    };
  }
  if (isBinary(oldBuf)) {
    return {
      targetPath,
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    };
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

export function computeDiff(
  targetPath: string,
  newContent: Buffer,
  desiredMode?: string,
): FileDiff {
  let isNew = false;
  let oldBuf: Buffer = Buffer.alloc(0);
  let isUnreadable = false;
  let lstatFailed = false;

  let stat: ReturnType<typeof fs.lstatSync> | undefined;
  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    // lstatSync failed — parent directory not searchable. Existence is unknown;
    // treat as existing (conservative). pull.ts uses sudoFileExists to verify
    // the true state after authenticating.
    lstatFailed = true;
    isUnreadable = true;
    isNew = false;
  }

  if (!lstatFailed) {
    isNew = stat === undefined;
    if (!isNew) {
      try {
        oldBuf = fs.readFileSync(targetPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Dangling symlink — lstatSync saw the symlink but readFileSync
          // followed it to a non-existent target. Treat as empty content:
          // the diff will show the full new content being written.
          // isUnreadable stays false; oldBuf stays empty Buffer.
        } else if (code === 'EACCES' || code === 'EPERM') {
          // File exists but is unreadable (e.g. root-owned 0600).
          isUnreadable = true;
        } else {
          throw err;
        }
      }
    }
  }

  let modeChange: { from: number; to: number } | undefined;
  if (!isNew && desiredMode && process.platform !== 'win32') {
    const desired = parseInt(desiredMode, 8);
    if (!isNaN(desired)) {
      try {
        const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
        if (stat !== undefined && !stat.isSymbolicLink()) {
          const current = stat.mode & 0o7777;
          if (desired !== current) {
            modeChange = { from: current, to: desired };
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'EPERM') throw err;
        // Cannot stat unreadable file — skip mode detection.
      }
    }
  }

  if (isUnreadable) {
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
      ...(lstatFailed && { lstatFailed: true }),
      modeChange,
    };
  }

  const binary = isBinary(newContent) || isBinary(oldBuf);

  if (binary) {
    const contentChanged = isNew || !newContent.equals(oldBuf);
    const hasChanges = contentChanged || modeChange !== undefined;
    return {
      targetPath,
      isNew,
      hasChanges,
      contentChanged,
      patch: '',
      isBinary: true,
      modeChange,
    };
  }

  const oldContent = oldBuf.toString('utf8');
  const newText = newContent.toString('utf8');
  const contentChanged = oldContent !== newText;
  const hasChanges = contentChanged || modeChange !== undefined;

  const patch = contentChanged
    ? createTwoFilesPatch(
        isNew ? '/dev/null' : targetPath,
        targetPath,
        oldContent,
        newText,
        isNew ? '' : undefined,
        isNew ? 'new file' : undefined,
      )
    : '';

  return {
    targetPath,
    isNew,
    hasChanges,
    contentChanged,
    patch,
    modeChange,
  };
}

/** Build a new-file FileDiff from content without reading disk. Used when
 *  lstatFailed initially but sudo confirms the file does not yet exist. */
export function buildNewFileDiff(
  targetPath: string,
  newContent: Buffer,
  modeChange?: { from: number; to: number },
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

export function computeSymlinkDiff(
  targetPath: string,
  symlinkTarget: string,
): FileDiff {
  let stat: ReturnType<typeof fs.lstatSync> | undefined;
  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
      lstatFailed: true,
      isSymlink: true,
    };
  }

  if (stat === undefined) {
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

  if (!stat.isSymbolicLink()) {
    const oldLabel = stat.isDirectory() ? '[directory]' : '[regular file]';
    const patch = createTwoFilesPatch(
      targetPath,
      targetPath,
      `${oldLabel}\n`,
      `-> ${symlinkTarget}\n`,
      `was ${oldLabel.slice(1, -1)}`,
      'replaced by symlink',
    );
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch,
      isSymlink: true,
    };
  }

  let currentTarget: string;
  try {
    currentTarget = fs.readlinkSync(targetPath);
  } catch {
    return {
      targetPath,
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isUnreadable: true,
      isSymlink: true,
    };
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
  return {
    targetPath,
    isNew: false,
    hasChanges: true,
    contentChanged: true,
    patch,
    isSymlink: true,
  };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return '';

  const colorLine = (line: string): string => {
    if (line.startsWith('+++') || line.startsWith('---'))
      return chalk.bold(line);
    if (line.startsWith('@@')) return chalk.cyan(line);
    if (line.startsWith('+')) return chalk.green(line);
    if (line.startsWith('-')) return chalk.red(line);
    return line;
  };

  if (diff.isSymlink) {
    if (diff.isUnreadable) {
      return (
        chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) +
        '\n' +
        chalk.cyan('@@ symlink (existing state unreadable) @@')
      );
    }
    return diff.patch.split('\n').map(colorLine).join('\n');
  }

  let modeFrom = '';
  let modeTo = '';
  if (diff.modeChange) {
    modeFrom = chalk.red(
      `-old mode ${diff.modeChange.from.toString(8).padStart(6, '0')}`,
    );
    modeTo = chalk.green(
      `+new mode ${diff.modeChange.to.toString(8).padStart(6, '0')}`,
    );
  }

  if (diff.isUnreadable) {
    // If content was confirmed unchanged via sudo re-read (contentChanged=false),
    // fall through to mode-only rendering so the diff accurately shows only
    // the permission change rather than the "unreadable content" placeholder.
    if (!diff.contentChanged && diff.modeChange) {
      // intentional fall-through to mode-only block below
    } else {
      const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
      const label = diff.isDelete
        ? 'file deleted (unreadable — no diff available)'
        : 'file updated (existing content unreadable — diff unavailable)';
      let out = chalk.bold(`--- ${diff.targetPath}\n+++ ${newPath}`) + '\n';
      if (diff.modeChange) out += modeFrom + '\n' + modeTo + '\n';
      out += chalk.cyan(`@@ ${label} @@`);
      return out;
    }
  }

  if (diff.isBinary) {
    let out = '';
    if (diff.contentChanged) {
      const label = diff.isNew
        ? 'new binary file'
        : diff.isDelete
          ? 'binary file deleted'
          : 'binary file changed';
      const oldPath = diff.isNew ? '/dev/null' : diff.targetPath;
      const newPath = diff.isDelete ? '/dev/null' : diff.targetPath;
      out += chalk.bold(`--- ${oldPath}\n+++ ${newPath}`) + '\n';
      if (diff.modeChange) out += modeFrom + '\n' + modeTo + '\n';
      out += chalk.cyan(`@@ ${label} @@`);
    } else if (diff.modeChange) {
      // Mode-only binary: emit file header + mode lines.
      out +=
        chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) + '\n';
      out += modeFrom + '\n' + modeTo;
    }
    return out;
  }

  if (diff.contentChanged) {
    const lines = diff.patch.split('\n');
    if (diff.modeChange) {
      // Inject mode lines after the +++ header line (git-style: header → mode
      // change → hunks). Find +++ by scan rather than fixed index because
      // createTwoFilesPatch may prepend Index:/=== lines before the header.
      const plusPlusIdx = lines.findIndex((l) => l.startsWith('+++'));
      if (plusPlusIdx >= 0) {
        const before = lines.slice(0, plusPlusIdx + 1).map(colorLine);
        const after = lines.slice(plusPlusIdx + 1).map(colorLine);
        return [...before, modeFrom, modeTo, ...after].join('\n');
      }
    }
    return lines.map(colorLine).join('\n');
  }

  // Mode-only text file.
  if (diff.modeChange) {
    return (
      chalk.bold(`--- ${diff.targetPath}\n+++ ${diff.targetPath}`) +
      '\n' +
      modeFrom +
      '\n' +
      modeTo
    );
  }

  return '';
}

export function printDiffs(diffs: FileDiff[]): void {
  const changed = diffs.filter((d) => d.hasChanges);
  if (!changed.length) {
    console.log('No changes.');
    return;
  }
  for (const d of changed) {
    console.log(formatDiff(d));
  }
}
