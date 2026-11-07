/** Validation of `symlink:` file entries against incompatible options. */
import * as path from 'path';
import { FileEntry, FileSrc, LocalSrc } from '../types';
import { isNonLocalSrcString } from '../sources/local';

export const SELF_KEY = '$self';

function isLocalFileSrc(src: FileSrc): boolean {
  if (typeof src === 'string') {
    return !isNonLocalSrcString(src);
  }
  if (!('path' in src)) return false;
  return !isNonLocalSrcString(src.path);
}

export function isDirectoryTarget(target: string): boolean {
  return target.endsWith('/') || target.endsWith(path.sep);
}

// Checked in this order; the first set field determines the error.
const LOCAL_SRC_CONFLICTS: ReadonlyArray<keyof LocalSrc> = [
  'sha',
  'filter',
  'if',
  'ifAny',
];

// Checked in this order; the first set option determines the error.
const ENTRY_CONFLICTS: ReadonlyArray<[string, (e: FileEntry) => unknown]> = [
  ['replace:', (e) => e.replace],
  ['template:', (e) => e.template],
  ['json:', (e) => e.json],
  ['yaml:', (e) => e.yaml],
  ['toml:', (e) => e.toml],
  ['ini:', (e) => e.ini],
  ['on.write:', (e) => e.on?.write],
  ['writeInPlace:', (e) => e.writeInPlace],
  ['strategy:', (e) => e.strategy],
  ['followSymlink:', (e) => e.followSymlink],
  [
    'mode — symlinks do not have independent permission bits on POSIX',
    (e) => e.mode,
  ],
];

function validateSymlinkSrc(target: string, src: FileEntry['src']): void {
  if (Array.isArray(src)) {
    throw new Error(
      `files["${target}"].symlink: cannot be combined with a list of sources`,
    );
  }
  if (!isLocalFileSrc(src)) {
    throw new Error(
      `files["${target}"].symlink: src must be a local path — ` +
        `http, exec, github, gitlab, and other remote sources are not supported`,
    );
  }
  if (typeof src === 'string' || !('path' in src)) return;
  const conflict = LOCAL_SRC_CONFLICTS.find((key) => src[key]);
  if (conflict !== undefined) {
    throw new Error(
      `files["${target}"].symlink: cannot be combined with src.${conflict}`,
    );
  }
}

/** Throws when a `symlink:` entry is combined with an unsupported option. */
export function validateSymlinkEntry(target: string, entry: FileEntry): void {
  if (target === SELF_KEY) {
    throw new Error(
      `files["${SELF_KEY}"].symlink: $self cannot be a symlink entry`,
    );
  }
  if (isDirectoryTarget(target)) {
    throw new Error(
      `files["${target}"].symlink: target must be a single file path, not a directory pattern (remove the trailing slash)`,
    );
  }
  validateSymlinkSrc(target, entry.src);
  const conflict = ENTRY_CONFLICTS.find(([, get]) => get(entry));
  if (conflict !== undefined) {
    throw new Error(
      `files["${target}"].symlink: cannot be combined with ${conflict[0]}`,
    );
  }
}
