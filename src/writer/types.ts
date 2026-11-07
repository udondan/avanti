/** Public target types shared by the unprivileged and privileged write paths. */

/** A sudo identity: `true` for root, or the name of the target user. */
export type SudoIdentity = true | string;

export interface SudoChmodTarget {
  targetPath: string;
  mode: string;
  sudo: true | string;
}

export interface WriteTarget {
  targetPath: string;
  content: Buffer;
  mode?: string;
  backupPath?: string;
  writeInPlace?: boolean;
  sudo?: true | string;
  symlinkTarget?: string;
}

export type SudoWriteTarget = WriteTarget & { sudo: true | string };
