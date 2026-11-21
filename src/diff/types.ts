export interface ModeChange {
  from: number;
  to: number;
}

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
  modeChange?: ModeChange;
  isSymlink?: boolean;
  /** True when the target path is an existing directory; symlinks cannot replace
   *  directories, so pull should error rather than attempt the write. */
  isDirectory?: boolean;
}

/** Rethrows `err` unless it is an EACCES/EPERM permission error. */
export function rethrowUnlessAccessDenied(err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EACCES' && code !== 'EPERM') throw err;
}
