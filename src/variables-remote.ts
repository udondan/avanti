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
function deepResolveVars(value: JsonValue, vars: Variables): JsonValue {
  if (typeof value === 'string') return resolveVars(value, vars);
  if (Array.isArray(value)) return value.map((v) => deepResolveVars(v, vars));
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      const name =
        (value as { constructor?: { name?: string } }).constructor?.name ??
        'unknown';
      throw new Error(
        `Variable value contains a non-plain object (${name}) — quote YAML timestamps and other special values`,
      );
    }
    const out = Object.create(null) as { [key: string]: JsonValue };
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepResolveVars(v, vars);
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
    } else if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('src' in value)
    ) {
      // Non-string, non-VariableEntry value (number, boolean, list, or plain
      // object) — resolve $vars in any string leaves.
      try {
        // deepResolveVars returns JsonValue (handles nested nulls), but value
        // was validated as non-null by parseVariables so the result is safe.
        resolved[name] = deepResolveVars(value, resolved) as VariableValue;
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
