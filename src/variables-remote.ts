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
        throw new Error(`variables.${name}: ${(err as Error).message}`, {
          cause: err,
        });
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
        throw new Error(
          `variables.${name}: failed to fetch source: ${(err as Error).message}`,
          { cause: err },
        );
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
      resolved[name] = buf.toString('utf8').trim();
    }
  }
  return resolved;
}
