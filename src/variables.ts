import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonValue, Variables, VariableSpec } from './types';

// $latest is a special sentinel used by the GitLab source to resolve the newest tag.
export const RESERVED_VARS = new Set(['latest']);

// Names users cannot define as variables (passthrough-reserved + system-injected).
export const RESERVED_VAR_NAMES = new Set([
  ...RESERVED_VARS,
  'self',
  'path',
  'filename',
  'basename',
  'ext',
  'dirname',
  'basedir',
  'date',
  'datetime',
]);

export function validateVariables(vars: Variables | VariableSpec): void {
  for (const name of Object.keys(vars)) {
    if (RESERVED_VAR_NAMES.has(name)) {
      throw new Error(`Variable name "${name}" is reserved and cannot be used`);
    }
  }
}

// Single-pass regex: $$ → literal $, then $env:NAME, then ${expr} (braced),
// then $name (unbraced). Ordering within the alternation matters: $$ must
// come first so it is consumed before any other branch matches the second $.
const TOKEN =
  /\$\$|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

type PathSegment =
  | { type: 'prop'; key: string }
  | { type: 'index'; index: number };

// Strict grammar: name ( '.' propKey | '[' integer ']' )*
// Each segment must be explicitly separated — missing dots (arr[0]key) and
// consecutive dots (a..b) are rejected rather than silently accepted.
const PATH_GRAMMAR =
  /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$/;
const PATH_SEG = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;

// Parse an expression like "servers[1].host" into a variable name + segments.
function parsePath(expr: string): { name: string; segments: PathSegment[] } {
  const m = PATH_GRAMMAR.exec(expr.trim());
  if (!m) {
    throw new Error(`Invalid path expression "\${${expr}}"`);
  }
  const name = m[1];
  const segments: PathSegment[] = [];
  PATH_SEG.lastIndex = 0;
  let seg: RegExpExecArray | null;
  while ((seg = PATH_SEG.exec(m[2])) !== null) {
    if (seg[1] !== undefined) {
      segments.push({ type: 'prop', key: seg[1] });
    } else {
      segments.push({ type: 'index', index: Number(seg[2]) });
    }
  }
  return { name, segments };
}

// Walk a JsonValue tree following the parsed segments, returning the leaf.
function walkPath(
  root: JsonValue,
  segments: PathSegment[],
  expr: string,
): JsonValue {
  let current: JsonValue = root;
  for (const seg of segments) {
    if (seg.type === 'prop') {
      if (
        typeof current !== 'object' ||
        current === null ||
        Array.isArray(current)
      ) {
        throw new Error(
          `Cannot access property "${seg.key}" on non-object in "\${${expr}}"`,
        );
      }
      if (!Object.hasOwn(current, seg.key)) {
        throw new Error(`Property "${seg.key}" not found in "\${${expr}}"`);
      }
      current = current[seg.key];
    } else {
      if (!Array.isArray(current)) {
        throw new Error(
          `Cannot use index [${seg.index}] on non-array in "\${${expr}}"`,
        );
      }
      if (seg.index >= current.length) {
        throw new Error(
          `Index [${seg.index}] out of bounds (length ${current.length}) in "\${${expr}}"`,
        );
      }
      current = current[seg.index];
    }
  }
  return current;
}

// Evaluate a braced path expression like "servers[1].host" against vars.
// Primitive leaf values are coerced to string; objects/arrays are JSON-serialised.
function evaluatePath(vars: Variables, expr: string): string {
  const { name, segments } = parsePath(expr.trim());
  if (RESERVED_VARS.has(name)) return `\${${expr}}`;
  if (!Object.hasOwn(vars, name))
    throw new Error(`Undefined variable: \${${expr}}`);
  const leaf = walkPath(vars[name], segments, expr);
  if (leaf === null) return 'null';
  if (typeof leaf !== 'object') return String(leaf);
  return JSON.stringify(leaf);
}

// Stringify a variable value for unbraced $name substitution.
// Strings pass through; complex types are JSON-serialised.
function stringifyValue(v: JsonValue): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return String(v);
  return JSON.stringify(v);
}

export function resolveVars(value: string, vars: Variables): string {
  return value.replace(
    TOKEN,
    (
      match,
      envName: string | undefined,
      bracedExpr: string | undefined,
      varName: string | undefined,
    ) => {
      if (match === '$$') return '$';
      if (envName !== undefined) {
        const val = process.env[envName];
        if (val === undefined) {
          throw new Error(`Undefined environment variable: $env:${envName}`);
        }
        return val;
      }
      if (bracedExpr !== undefined) {
        return evaluatePath(vars, bracedExpr);
      }
      if (RESERVED_VARS.has(varName!)) return match;
      if (!Object.hasOwn(vars, varName!)) {
        throw new Error(`Undefined variable: $${varName}`);
      }
      return stringifyValue(vars[varName!]);
    },
  );
}

// Single-quote escaping for shell injection prevention.
// POSIX sh: escape ' as '\''  — PowerShell: escape ' as ''
function shellQuote(val: string): string {
  if (process.platform === 'win32') {
    return "'" + val.replace(/'/g, "''") + "'";
  }
  return "'" + val.replace(/'/g, "'\\''") + "'";
}

// Like resolveVars but shell-quotes each substituted value, preventing
// metacharacters in variable values (especially $env: vars) from being
// interpreted by the shell. Used by exec sources and post processors.
// On Unix the resolved script is passed to sh -c; on Windows it is
// Base64-encoded and passed to PowerShell via -EncodedCommand.
export function resolveVarsShellSafe(value: string, vars: Variables): string {
  return value.replace(
    TOKEN,
    (
      match,
      envName: string | undefined,
      bracedExpr: string | undefined,
      varName: string | undefined,
    ) => {
      if (match === '$$') return '$';
      if (envName !== undefined) {
        const val = process.env[envName];
        if (val === undefined) {
          throw new Error(`Undefined environment variable: $env:${envName}`);
        }
        return shellQuote(val);
      }
      if (bracedExpr !== undefined) {
        return shellQuote(evaluatePath(vars, bracedExpr));
      }
      if (RESERVED_VARS.has(varName!)) return match;
      if (!Object.hasOwn(vars, varName!)) {
        throw new Error(`Undefined variable: $${varName}`);
      }
      return shellQuote(stringifyValue(vars[varName!]));
    },
  );
}

// Build the per-file path variables for a resolved absolute target path.
export function buildFileVars(targetPath: string): Variables {
  const filename = path.basename(targetPath);
  const ext = path.extname(targetPath).replace(/^\./, '');
  const basename = ext ? filename.slice(0, -(ext.length + 1)) : filename;
  const dirname = path.dirname(targetPath);
  return Object.assign(Object.create(null) as Variables, {
    path: targetPath,
    filename,
    basename,
    ext,
    dirname,
    basedir: path.basename(dirname),
  });
}

// Build date/datetime variables from a given Date (defaults to now).
export function buildDateVars(now: Date = new Date()): Variables {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-');
  const datetime = [
    date,
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
  return Object.assign(Object.create(null) as Variables, { date, datetime });
}

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
