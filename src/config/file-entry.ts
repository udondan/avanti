/** Parsing of a single `files:` map entry. */
import { FileEntry } from '../types';
import { assignConditions, parseConditionField } from './conditions';
import {
  parseExtract,
  parseMode,
  parseOnHooks,
  parseReplaceRules,
  parseStrategy,
  parseSudo,
  parseSymlinkMode,
} from './file-fields';
import { assignFormatOptions } from './merge-options';
import { parseSrcField } from './sources';
import { validateSymlinkEntry } from './symlink';
import { isPlainObject } from './validate';

function assignBooleanFlags(
  fileEntry: FileEntry,
  e: Record<string, unknown>,
): void {
  if (typeof e['writeInPlace'] === 'boolean')
    fileEntry.writeInPlace = e['writeInPlace'];
  if (typeof e['followSymlink'] === 'boolean')
    fileEntry.followSymlink = e['followSymlink'];
}

function assignWriteOptions(
  fileEntry: FileEntry,
  e: Record<string, unknown>,
  target: string,
): void {
  if (e['post'] !== undefined) {
    throw new Error(`files["${target}"].post: removed — use on.write instead`);
  }
  if (e['on'] !== undefined) fileEntry.on = parseOnHooks(e['on'], target);
  assignBooleanFlags(fileEntry, e);
  if (e['symlink'] !== undefined) {
    fileEntry.symlink = parseSymlinkMode(e['symlink'], target);
  }
  if (e['sudo'] !== undefined) {
    const sudo = parseSudo(e['sudo'], target);
    if (sudo !== undefined) fileEntry.sudo = sudo;
  }
  if (e['strategy'] !== undefined) {
    fileEntry.strategy = parseStrategy(e['strategy'], target);
  }
  if (fileEntry.strategy === 'insert' && fileEntry.sudo) {
    throw new Error(
      `files["${target}"]: strategy "insert" cannot be combined with sudo — ` +
        `insert mode reads the existing file without privilege escalation, ` +
        `which silently treats an unreadable privileged file as absent. ` +
        `Use a non-insert strategy, or manage the file without sudo.`,
    );
  }
}

/** Parses and validates one entry of the `files:` map. */
export function parseFileEntry(target: string, entry: unknown): FileEntry {
  if (!isPlainObject(entry)) {
    throw new Error(`files["${target}"]: must be an object`);
  }
  const e = entry;

  if (e['src'] === undefined || e['src'] === null) {
    throw new Error(`files["${target}"]: "src" is required`);
  }

  const src = parseSrcField(e['src'], `files["${target}"]`);
  const fileEntry: FileEntry = { src, target };

  assignConditions(fileEntry, parseConditionField(e, `files["${target}"]`));

  const mode = parseMode(e['mode'], target);
  if (mode !== undefined) fileEntry.mode = mode;
  if (typeof e['backup'] === 'string') fileEntry.backup = e['backup'];
  assignWriteOptions(fileEntry, e, target);

  if (e['replace'] !== undefined) {
    fileEntry.replace = parseReplaceRules(e['replace'], target);
  }

  assignFormatOptions(fileEntry, e, `files["${target}"]`);

  if (e['extract'] !== undefined) {
    fileEntry.extract = parseExtract(e['extract'], {
      target,
      symlink: !!fileEntry.symlink,
      multiSrc: Array.isArray(src),
    });
  }

  if (fileEntry.symlink) validateSymlinkEntry(target, fileEntry);

  return fileEntry;
}
