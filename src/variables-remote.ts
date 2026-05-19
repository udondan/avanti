import { FileEntry, Variables, VariableSpec } from './types';
import { resolveVars } from './variables';
import { fetchSource, FetchCache, FetchResult } from './sources';
import { isBinary } from './binary';

export async function resolveVariableSpec(
  spec: VariableSpec,
  workingDir: string,
  cache?: FetchCache,
): Promise<Variables> {
  const resolved: Variables = Object.create(null) as Variables;
  for (const [name, value] of Object.entries(spec)) {
    if (typeof value === 'string') {
      try {
        resolved[name] = resolveVars(value, resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`variables.${name}: ${msg}`, { cause: err });
      }
    } else {
      const synthetic: FileEntry = {
        src: value.src,
        target: name,
        json: value.json,
        yaml: value.yaml,
        toml: value.toml,
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
      const buf = result.files.values().next().value as Buffer;
      if (isBinary(buf)) {
        throw new Error(
          `variables.${name}: source resolved to binary content, which cannot be used as a variable value`,
        );
      }
      let text = buf.toString('utf8');
      if (value.template !== undefined) {
        const { applyTemplate } = await import('./processors/template');
        try {
          text = await applyTemplate(text, value.template, resolved);
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
