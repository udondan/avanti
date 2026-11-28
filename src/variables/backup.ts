/** Backup path pattern resolution and containment checks. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Variables } from '../types';
import { buildFileVars } from './builtins';
import { resolveVars } from './resolve';

// Counter token pattern: one or more 'd' characters preceded by '%'.
// Width is validated separately (max 3) to give a clear error on oversized tokens.
const COUNTER_TOKEN = /%d+/g;
const MAX_COUNTER_WIDTH = 3;

// Resolve the auto-increment counter in a backup path pattern.
// The pattern must contain at most one %d/%dd/%ddd token. Width > 3 is
// rejected to prevent unbounded filesystem scanning. Scans from slot 1
// upward to find the lowest path that does not yet exist on disk.
// Throws if all slots are taken or if the token width exceeds the maximum.
export function resolveBackupCounter(pattern: string): string {
  const tokens = [...pattern.matchAll(COUNTER_TOKEN)];
  if (tokens.length === 0) return pattern;
  if (tokens.length > 1) {
    throw new Error(
      `backup path may contain at most one counter token (%d+), found ${tokens.length}: "${pattern}"`,
    );
  }

  const token = tokens[0][0];
  const width = token.length - 1; // number of 'd' characters
  if (width > MAX_COUNTER_WIDTH) {
    throw new Error(
      `backup counter width ${width} exceeds maximum ${MAX_COUNTER_WIDTH} — use %d, %dd, or %ddd`,
    );
  }
  const max = Math.pow(10, width) - 1;

  for (let i = 1; i <= max; i++) {
    const padded = String(i).padStart(width, '0');
    const candidate = pattern.replace(token, padded);
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) return candidate;
  }

  throw new Error(
    `backup path counter exhausted: all slots ${'1'.padStart(width, '0')}–${String(max).padStart(width, '0')} are taken for "${pattern}"`,
  );
}

// Expand a backup root entry: resolve ~/ and canonicalize the path.
// Relative paths are rejected — they would resolve against process.cwd(),
// not workingDir, making the security boundary invocation-dependent.
function expandRoot(root: string): string {
  if (root.startsWith('~/')) {
    return path.resolve(os.homedir(), root.slice(2));
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `backup_roots entry "${root}" is a relative path. Use an absolute path or ~/`,
    );
  }
  return path.resolve(root);
}

// Normalize a path for containment checks: on Windows paths are
// case-insensitive and may use either slash; fold both to canonical form.
function normalizePath(p: string): string {
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\').toLowerCase();
  }
  return p;
}

// Assert that a resolved backup path is allowed given the security model:
// - Paths within workingDir are always allowed.
// - All other paths must fall under a declared backup_roots entry.
export function assertBackupPathAllowed(
  backupPath: string,
  workingDir: string,
  backupRoots: string[],
): void {
  const bp = normalizePath(backupPath);
  const wd = normalizePath(workingDir);
  const wdPrefix = wd.endsWith(path.sep) ? wd : wd + path.sep;
  if (bp === wd || bp.startsWith(wdPrefix)) return;

  for (const root of backupRoots) {
    const expanded = normalizePath(expandRoot(root));
    const rootPrefix = expanded.endsWith(path.sep)
      ? expanded
      : expanded + path.sep;
    if (bp === expanded || bp.startsWith(rootPrefix)) return;
  }

  throw new Error(
    `backup path "${backupPath}" is outside the working directory. ` +
      `Add a backup_roots entry to allow it.`,
  );
}

// Resolve a backup path pattern for a given target file.
// Resolution order:
//   1. Substitute $ variables (including per-file vars derived from targetPath).
//   2. Expand ~/ prefix.
//   3. Resolve relative paths against workingDir.
//   4. Assert the path is allowed.
//   5. Resolve %d+ counter (filesystem scan).
export function resolveBackupPath(
  pattern: string,
  targetPath: string,
  workingDir: string,
  vars: Variables,
  backupRoots: string[],
): string {
  const fileVars = buildFileVars(targetPath);
  const merged = Object.assign(
    Object.create(null) as Variables,
    vars,
    fileVars,
  );

  let resolved = resolveVars(pattern, merged);

  if (resolved.startsWith('~/')) {
    resolved = path.resolve(os.homedir(), resolved.slice(2));
  } else if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(workingDir, resolved);
  } else {
    // Already absolute — canonicalize to remove any .. components so that
    // paths like /workdir/../etc/passwd don't bypass assertBackupPathAllowed.
    resolved = path.resolve(resolved);
  }

  if (normalizePath(resolved) === normalizePath(path.resolve(targetPath))) {
    throw new Error(
      `backup path resolves to the target file itself: "${resolved}"`,
    );
  }

  assertBackupPathAllowed(resolved, workingDir, backupRoots);

  const finalPath = resolveBackupCounter(resolved);
  if (fs.lstatSync(finalPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `backup path "${finalPath}" is a directory — specify a file path`,
    );
  }
  return finalPath;
}
