import {
  EnvironmentEntry,
  EnvironmentSpec,
  FileEntry,
  Variables,
} from './types';
import { resolveVars } from './variables';
import { fetchSource, FetchCache, FetchResult } from './sources';
import { isBinary } from './binary';

// avanti injects these itself for `on:` write hooks — a user-defined
// environment: block must not be able to shadow them.
export const RESERVED_ENV_KEYS = new Set(['AVANTI_TARGET', 'AVANTI_IS_NEW']);

// Required so $env:NAME (which only accepts this grammar) can reference any
// key declared here.
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnvironmentNames(spec: EnvironmentSpec): void {
  for (const name of Object.keys(spec)) {
    if (RESERVED_ENV_KEYS.has(name)) {
      throw new Error(
        `Environment variable name "${name}" is reserved and cannot be used`,
      );
    }
    if (!ENV_KEY_PATTERN.test(name)) {
      throw new Error(
        `Environment variable name "${name}" is invalid — must match ${ENV_KEY_PATTERN}`,
      );
    }
  }
}

// Resolve a single environment: entry to its string value. Mirrors the
// source-backed branch of resolveVariableEntry in variables-remote.ts, minus
// json/yaml/toml/ini/template support (out of scope for environment:).
export async function resolveEnvironmentEntry(
  name: string,
  value: string | EnvironmentEntry,
  vars: Variables,
  workingDir: string,
  cache?: FetchCache,
  configBase?: string,
): Promise<string> {
  if (typeof value === 'string') {
    try {
      return resolveVars(value, vars);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`environment.${name}: ${msg}`, { cause: err });
    }
  }

  const synthetic: FileEntry = { src: value.src, target: name };
  let result: FetchResult;
  try {
    result = await fetchSource(
      synthetic,
      workingDir,
      vars,
      cache,
      undefined,
      undefined,
      configBase,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`environment.${name}: failed to fetch source: ${msg}`, {
      cause: err,
    });
  }
  if (result.files.size === 0) {
    throw new Error(`environment.${name}: source resolved to no content`);
  }
  if (result.files.size > 1) {
    throw new Error(
      `environment.${name}: source resolved to multiple files — environment: entries must resolve to a single scalar value`,
    );
  }
  const [, buf] = result.files.entries().next().value as [string, Buffer];
  if (isBinary(buf)) {
    throw new Error(
      `environment.${name}: source resolved to binary content, which cannot be used as an environment variable value`,
    );
  }
  return buf.toString('utf8').trim();
}
