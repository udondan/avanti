import {
  EnvironmentSpec,
  JsonValue,
  Variables,
  VariableEntry,
  VariableSpec,
  VariableValue,
} from './types';
import { resolveVars } from './variables';
import { FetchCache } from './sources';
import {
  errorMessage,
  FetchContext,
  fetchSingleText,
  withScope,
} from './variables/source-text';

// Non-JSON-compatible primitives that can reach the resolvers from
// programmatic callers who bypass TypeScript (e.g. via `as any`).
const UNSUPPORTED_TYPES = new Set([
  'undefined',
  'bigint',
  'symbol',
  'function',
]);

function isUnsupportedType(value: unknown): boolean {
  return UNSUPPORTED_TYPES.has(typeof value);
}

function assertNotSeen(value: object, seen: WeakSet<object>, path: string) {
  if (seen.has(value)) {
    throw new Error(`Variable value contains a circular reference at ${path}`);
  }
}

function assertPlainObject(value: object, path: string): void {
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto === Object.prototype || proto === null) return;
  const typeName =
    (value as { constructor?: { name?: string } }).constructor?.name ??
    'unknown';
  const at = path ? ` at ${path}` : '';
  throw new Error(
    `Variable value contains a non-plain object (${typeName})${at} — only plain objects and arrays are supported as variable values. If loading from YAML, quote timestamps and other auto-typed values.`,
  );
}

function keyPathPart(k: string): string {
  if (!/[.[\]"']/.test(k)) return `.${k}`;
  const escaped = k.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return '["' + escaped + '"]';
}

function deepResolveArray(
  value: JsonValue[],
  vars: Variables,
  path: string,
  seen: WeakSet<object>,
): JsonValue {
  assertNotSeen(value, seen, path);
  seen.add(value);
  const result = value.map((v, i) =>
    deepResolveVars(v, vars, `${path}[${i}]`, seen),
  );
  seen.delete(value);
  return result;
}

function deepResolveObject(
  value: { [key: string]: JsonValue },
  vars: Variables,
  path: string,
  seen: WeakSet<object>,
): JsonValue {
  assertNotSeen(value, seen, path);
  assertPlainObject(value, path);
  seen.add(value);
  const out = Object.create(null) as { [key: string]: JsonValue };
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepResolveVars(v, vars, path + keyPathPart(k), seen);
  }
  seen.delete(value);
  return out;
}

// Recursively resolve $var references in all string leaves of a JsonValue.
// `seen` tracks the current DFS path for cycle detection; it is backtracked
// after each object/array so shared (non-circular) references are not flagged.
function deepResolveVars(
  value: JsonValue,
  vars: Variables,
  path = '',
  seen = new WeakSet<object>(),
): JsonValue {
  if (typeof value === 'string') return resolveVars(value, vars);
  if (isUnsupportedType(value)) {
    throw new Error(
      `Variable value has unsupported type "${typeof value}" at ${path} — only string, number, boolean, null, array, and plain object are allowed`,
    );
  }
  if (Array.isArray(value)) return deepResolveArray(value, vars, path, seen);
  if (typeof value === 'object' && value !== null) {
    return deepResolveObject(value, vars, path, seen);
  }
  return value;
}

// Use `in` for TypeScript narrowing; Object.hasOwn guards against inherited
// `src` properties from programmatic callers.
function isSourceEntry(
  value: VariableValue | VariableEntry,
): value is VariableEntry {
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'src' in value &&
    Object.hasOwn(value, 'src')
  );
}

async function renderTemplate(
  scope: string,
  text: string,
  entry: VariableEntry,
  ctx: { resolved: Variables; srcPath: string },
): Promise<string> {
  const { applyTemplate } = await import('./processors/template');
  try {
    return await applyTemplate(
      text,
      entry.template as NonNullable<VariableEntry['template']>,
      ctx.resolved,
      ctx.srcPath || undefined,
    );
  } catch (err) {
    throw new Error(
      `${scope}: template rendering failed: ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

async function resolveSourceEntry(
  name: string,
  entry: VariableEntry,
  resolved: Variables,
  workingDir: string,
  ctx: FetchContext,
): Promise<string> {
  const scope = `variables.${name}`;
  const { srcPath, text } = await fetchSingleText(
    {
      scope,
      entry: {
        src: entry.src,
        target: name,
        json: entry.json,
        yaml: entry.yaml,
        toml: entry.toml,
        ini: entry.ini,
      },
      vars: resolved,
      workingDir,
      ctx,
    },
    {
      multiple:
        'source resolved to multiple files; set json/yaml/toml/ini to merge them into one',
      binary:
        'source resolved to binary content, which cannot be used as a variable value',
    },
  );
  if (entry.template === undefined) return text.trim();
  const rendered = await renderTemplate(scope, text, entry, {
    resolved,
    srcPath,
  });
  return rendered.trim();
}

// Resolve a single variables: entry to its value, using `resolved` (the
// accumulator of already-resolved names) for any $var references. Shared by
// resolveVariableSpec (declaration-order, variables-only) and the dependency
// graph engine in context.ts (topological order, combined with environment:).
export async function resolveVariableEntry(
  name: string,
  value: VariableValue | VariableEntry,
  resolved: Variables,
  workingDir: string,
  ctx: FetchContext = {},
): Promise<VariableValue> {
  const scope = `variables.${name}`;
  if (typeof value === 'string') {
    return withScope(scope, () => resolveVars(value, resolved));
  }
  if (value === null) {
    throw new Error(`${scope}: value must not be null`);
  }
  if (isUnsupportedType(value)) {
    throw new Error(
      `${scope}: unsupported value type "${typeof value}" — value must be a string, number, boolean, list, or plain object`,
    );
  }
  if (isSourceEntry(value)) {
    return resolveSourceEntry(name, value, resolved, workingDir, ctx);
  }
  // Non-string, non-VariableEntry value (number, boolean, list, or plain
  // object) — resolve $vars in any string leaves. deepResolveVars returns
  // JsonValue (handles nested nulls), but null is rejected above so the cast
  // to VariableValue is sound.
  return withScope(
    scope,
    () => deepResolveVars(value as JsonValue, resolved) as VariableValue,
  );
}

export async function resolveVariableSpec(
  spec: VariableSpec,
  workingDir: string,
  cache?: FetchCache,
  configBase?: string,
): Promise<Variables> {
  const { resolveVariablesAndEnvironment } = await import('./context');
  const { vars } = await resolveVariablesAndEnvironment(
    spec,
    Object.create(null) as EnvironmentSpec,
    workingDir,
    cache,
    configBase,
  );
  return vars;
}
