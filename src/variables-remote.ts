import {
  FileEntry,
  JsonValue,
  Variables,
  VariableEntry,
  VariableSpec,
  VariableValue,
} from './types';
import { resolveVars } from './variables';
import { fetchSource, FetchCache, FetchResult } from './sources';
import { isBinary } from './binary';

// Recursively resolve $var references in all string leaves of a JsonValue.
function deepResolveVars(
  value: JsonValue,
  vars: Variables,
  path = '',
): JsonValue {
  if (typeof value === 'string') return resolveVars(value, vars);
  if (Array.isArray(value)) {
    return value.map((v, i) => deepResolveVars(v, vars, `${path}[${i}]`));
  }
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      const typeName =
        (value as { constructor?: { name?: string } }).constructor?.name ??
        'unknown';
      const at = path ? ` at ${path}` : '';
      throw new Error(
        `Variable value contains a non-plain object (${typeName})${at} — only plain objects and arrays are supported as variable values. If loading from YAML, quote timestamps and other auto-typed values.`,
      );
    }
    const out = Object.create(null) as { [key: string]: JsonValue };
    for (const [k, v] of Object.entries(value)) {
      const keyPart = /[.[\]"']/.test(k)
        ? `["${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
        : `.${k}`;
      out[k] = deepResolveVars(v, vars, `${path}${keyPart}`);
    }
    return out;
  }
  return value;
}

export async function resolveVariableSpec(
  spec: VariableSpec,
  workingDir: string,
  cache?: FetchCache,
): Promise<Variables> {
  const resolved: Variables = Object.create(null) as Variables;
  let applyTemplate:
    | typeof import('./processors/template').applyTemplate
    | undefined;
  for (const [name, value] of Object.entries(spec)) {
    if (typeof value === 'string') {
      try {
        resolved[name] = resolveVars(value, resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`variables.${name}: ${msg}`, { cause: err });
      }
    } else if (value === null) {
      throw new Error(`variables.${name}: value must not be null`);
    } else if (
      typeof value === 'undefined' ||
      typeof value === 'bigint' ||
      typeof value === 'symbol' ||
      typeof value === 'function'
    ) {
      throw new Error(
        `variables.${name}: unsupported value type "${typeof value}" — value must be a string, number, boolean, list, or plain object`,
      );
    } else if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      // Use `in` for TypeScript narrowing; Object.hasOwn guards against
      // inherited `src` properties from programmatic callers.
      !('src' in value) ||
      !Object.hasOwn(value, 'src')
    ) {
      // Non-string, non-VariableEntry value (number, boolean, list, or plain
      // object) — resolve $vars in any string leaves.
      try {
        // deepResolveVars returns JsonValue (handles nested nulls), but null
        // is rejected above so the cast to VariableValue is sound.
        // TS can't narrow VariableEntry away via Object.hasOwn; the cast is
        // safe — only values without an own `src` reach this branch.
        resolved[name] = deepResolveVars(
          value as JsonValue,
          resolved,
        ) as VariableValue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`variables.${name}: ${msg}`, { cause: err });
      }
    } else {
      const entry = value as VariableEntry;
      const synthetic: FileEntry = {
        src: entry.src,
        target: name,
        json: entry.json,
        yaml: entry.yaml,
        toml: entry.toml,
      };
      let result: FetchResult;
      try {
        result = await fetchSource(synthetic, workingDir, resolved, cache);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`variables.${name}: failed to fetch source: ${msg}`, {
          cause: err,
        });
      }
      if (result.files.size === 0) {
        throw new Error(`variables.${name}: source resolved to no content`);
      }
      if (result.files.size > 1) {
        throw new Error(
          `variables.${name}: source resolved to multiple files; set json/yaml/toml to merge them into one`,
        );
      }
      const [srcPath, buf] = result.files.entries().next().value as [
        string,
        Buffer,
      ];
      if (isBinary(buf)) {
        throw new Error(
          `variables.${name}: source resolved to binary content, which cannot be used as a variable value`,
        );
      }
      let text = buf.toString('utf8');
      if (entry.template !== undefined) {
        applyTemplate ??= (await import('./processors/template')).applyTemplate;
        try {
          text = await applyTemplate(
            text,
            entry.template,
            resolved,
            srcPath || undefined,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `variables.${name}: template rendering failed: ${msg}`,
            { cause: err },
          );
        }
      }
      resolved[name] = text.trim();
    }
  }
  return resolved;
}
