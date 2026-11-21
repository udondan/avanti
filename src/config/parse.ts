/** Parsing of a complete config document into an AvantiConfig. */
import * as yaml from 'js-yaml';
import { parseDocument, isMap, isScalar, Scalar } from 'yaml';
import { AvantiConfig, FileEntry } from '../types';
import { expandBraces } from '../paths';
import { parseFileEntry } from './file-entry';
import { isDirectoryTarget } from './symlink';
import { parseEnvironment, parseVariables } from './variable-specs';
import { isPlainObject } from './validate';

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function isIntegerScalar(node: unknown): node is Scalar<number> {
  return (
    isScalar(node) &&
    typeof node.value === 'number' &&
    Number.isInteger(node.value)
  );
}

function octalModeReplacement(
  content: string,
  modeNode: unknown,
): Replacement | undefined {
  if (!isIntegerScalar(modeNode) || !modeNode.range) return undefined;
  const raw = content.slice(modeNode.range[0], modeNode.range[1]);
  if (!raw.startsWith('0o')) return undefined;
  const digits = raw.slice(2);
  return {
    start: modeNode.range[0],
    end: modeNode.range[1],
    text: `"${digits.padStart(4, '0')}"`,
  };
}

// Normalize YAML 0o-prefixed octal literals in files[*].mode before js-yaml
// parses the content. js-yaml discards the 0o prefix, turning e.g. 0o644
// into integer 420. We use the yaml package's AST to locate only actual
// files[*].mode scalar values (never block-scalar content or other fields),
// then do a targeted string replacement at the exact character range.
function normalizeOctalModes(content: string): string {
  try {
    const doc = parseDocument(content);
    const filesNode = doc.get('files', true);
    if (!isMap(filesNode)) return content;
    const replacements: Replacement[] = [];
    for (const pair of filesNode.items) {
      const entryNode = (pair as { value?: unknown }).value;
      if (!isMap(entryNode)) continue;
      const r = octalModeReplacement(content, entryNode.get('mode', true));
      if (r) replacements.push(r);
    }
    // Apply in reverse order so earlier offsets stay valid.
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      content = content.slice(0, r.start) + r.text + content.slice(r.end);
    }
  } catch {
    // If AST parse fails, fall through to js-yaml which will produce its own
    // error with better context.
  }
  return content;
}

function loadYamlObject(content: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }

  if (!isPlainObject(raw)) {
    throw new Error('Config must be a YAML object');
  }
  return raw;
}

function duplicateTargetError(
  expandedTarget: string,
  target: string,
  existingOrigin: string | undefined,
): Error {
  const parts: string[] = [];
  if (expandedTarget !== target) {
    parts.push(`expanded from "${target}"`);
  }
  if (existingOrigin !== undefined && existingOrigin !== target) {
    parts.push(`existing entry expanded from "${existingOrigin}"`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return new Error(`files["${expandedTarget}"]: duplicate target${suffix}`);
}

function expandTargets(target: string): string[] {
  try {
    return expandBraces(target);
  } catch (err) {
    throw new Error(`files["${target}"]: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/** Collects file entries keyed by their brace-expanded targets. */
class FileTable {
  readonly files: Record<string, FileEntry> = Object.create(null) as Record<
    string,
    FileEntry
  >;
  private readonly origins: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>;

  add(target: string, fileEntry: FileEntry): void {
    for (const expandedTarget of expandTargets(target)) {
      this.addExpanded(expandedTarget, target, fileEntry);
    }
  }

  private addExpanded(
    expandedTarget: string,
    target: string,
    fileEntry: FileEntry,
  ): void {
    if (expandedTarget in this.files) {
      throw duplicateTargetError(
        expandedTarget,
        target,
        this.origins[expandedTarget],
      );
    }
    const expanded = expandedTarget !== target;
    if (fileEntry.symlink && expanded && isDirectoryTarget(expandedTarget)) {
      throw new Error(
        `files["${expandedTarget}"] (expanded from "${target}").symlink: target must be a single file path, not a directory pattern (remove the trailing slash)`,
      );
    }
    this.files[expandedTarget] = { ...fileEntry, target: expandedTarget };
    if (expanded) {
      this.origins[expandedTarget] = target;
    }
  }
}

function parseBackupRoots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !(value as unknown[]).every((r) => typeof r === 'string')
  ) {
    throw new Error('"backup_roots" must be a list of strings');
  }
  return value as string[];
}

export function parseConfigContent(content: string): AvantiConfig {
  const obj = loadYamlObject(normalizeOctalModes(content));

  if (!isPlainObject(obj['files'])) {
    throw new Error('Config must have a "files" map');
  }

  const variables = parseVariables(obj['variables']);
  const environment = parseEnvironment(obj['environment']);
  for (const name of Object.keys(environment)) {
    if (Object.hasOwn(variables, name)) {
      throw new Error(
        `"${name}" is declared in both "variables" and "environment" — pick one`,
      );
    }
  }

  const table = new FileTable();
  for (const [target, entry] of Object.entries(obj['files'])) {
    table.add(target, parseFileEntry(target, entry));
  }

  const backup_roots = parseBackupRoots(obj['backup_roots']);

  return { variables, environment, backup_roots, files: table.files };
}
