/** `$name`, `${path.expr}` and `$env:NAME` substitution. */
import { JsonValue, Variables, VariableSpec } from '../types';

// $latest and $recent are special sentinels for resolving tags across all git-hosting sources.
const RESERVED_VARS = new Set(['latest', 'recent']);

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
  'os',
  'arch',
  'arch_go',
  'workingDir',
  'cwd',
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
export const TOKEN =
  /\$\$|\$env:([A-Za-z_]\w*)|\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g;

type PathSegment =
  { type: 'prop'; key: string } | { type: 'index'; index: number };

// Strict grammar: name ( '.' propKey | '[' integer ']' )*
// Each segment must be explicitly separated — missing dots (arr[0]key) and
// consecutive dots (a..b) are rejected rather than silently accepted.
const PATH_GRAMMAR = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*|\[\d+\])*)$/;
const PATH_SEG = /\.([A-Za-z_]\w*)|\[(\d+)\]/g;

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

function stepProp(current: JsonValue, key: string, expr: string): JsonValue {
  if (
    typeof current !== 'object' ||
    current === null ||
    Array.isArray(current)
  ) {
    throw new Error(
      `Cannot access property "${key}" on non-object in "\${${expr}}"`,
    );
  }
  if (!Object.hasOwn(current, key)) {
    throw new Error(`Property "${key}" not found in "\${${expr}}"`);
  }
  return current[key];
}

function stepIndex(current: JsonValue, index: number, expr: string): JsonValue {
  if (!Array.isArray(current)) {
    throw new Error(
      `Cannot use index [${index}] on non-array in "\${${expr}}"`,
    );
  }
  if (index >= current.length) {
    throw new Error(
      `Index [${index}] out of bounds (length ${current.length}) in "\${${expr}}"`,
    );
  }
  return current[index];
}

// Walk a JsonValue tree following the parsed segments, returning the leaf.
function walkPath(
  root: JsonValue,
  segments: PathSegment[],
  expr: string,
): JsonValue {
  let current: JsonValue = root;
  for (const seg of segments) {
    current =
      seg.type === 'prop'
        ? stepProp(current, seg.key, expr)
        : stepIndex(current, seg.index, expr);
  }
  return current;
}

// Stringify a variable value for substitution.
// Strings pass through; complex types are JSON-serialised.
function stringifyValue(v: JsonValue): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return String(v);
  return JSON.stringify(v);
}

// Evaluate a braced path expression like "servers[1].host" against vars.
// Returns null to signal reserved-var passthrough (caller should return the
// original match token unchanged). Primitive leaf values are coerced to
// string; objects/arrays are JSON-serialised.
function evaluatePath(vars: Variables, expr: string): string | null {
  const { name, segments } = parsePath(expr.trim());
  if (RESERVED_VARS.has(name)) return null;
  if (!Object.hasOwn(vars, name))
    throw new Error(`Undefined variable: \${${expr}}`);
  return stringifyValue(walkPath(vars[name], segments, expr));
}

// Replace every TOKEN in `value`, passing each substituted value through
// `quote` (identity for plain substitution, shell quoting for exec contexts).
function substitute(
  value: string,
  vars: Variables,
  quote: (val: string) => string,
): string {
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
        return quote(val);
      }
      if (bracedExpr !== undefined) {
        const result = evaluatePath(vars, bracedExpr);
        return result === null ? match : quote(result);
      }
      const name = String(varName);
      if (RESERVED_VARS.has(name)) return match;
      if (!Object.hasOwn(vars, name)) {
        throw new Error(`Undefined variable: $${name}`);
      }
      return quote(stringifyValue(vars[name]));
    },
  );
}

export function resolveVars(value: string, vars: Variables): string {
  return substitute(value, vars, (val) => val);
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
  return substitute(value, vars, shellQuote);
}
