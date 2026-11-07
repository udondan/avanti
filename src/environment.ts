import { EnvironmentEntry, EnvironmentSpec, Variables } from './types';
import { resolveVars } from './variables';
import {
  FetchContext,
  fetchSingleText,
  withScope,
} from './variables/source-text';

// avanti injects these itself for `on:` write hooks — a user-defined
// environment: block must not be able to shadow them.
const RESERVED_ENV_KEYS = new Set(['AVANTI_TARGET', 'AVANTI_IS_NEW']);

// Required so $env:NAME (which only accepts this grammar) can reference any
// key declared here. `\w` is exactly [A-Za-z0-9_] without the `u` flag; the
// message keeps the long-hand spelling users have always seen.
const ENV_KEY_PATTERN = /^[A-Za-z_]\w*$/;
const ENV_KEY_GRAMMAR = '/^[A-Za-z_][A-Za-z0-9_]*$/';

export function validateEnvironmentNames(spec: EnvironmentSpec): void {
  for (const name of Object.keys(spec)) {
    if (RESERVED_ENV_KEYS.has(name)) {
      throw new Error(
        `Environment variable name "${name}" is reserved and cannot be used`,
      );
    }
    if (!ENV_KEY_PATTERN.test(name)) {
      throw new Error(
        `Environment variable name "${name}" is invalid — must match ${ENV_KEY_GRAMMAR}`,
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
  ctx: FetchContext = {},
): Promise<string> {
  const scope = `environment.${name}`;
  if (typeof value === 'string') {
    return withScope(scope, () => resolveVars(value, vars));
  }
  const { text } = await fetchSingleText(
    { scope, entry: { src: value.src, target: name }, vars, workingDir, ctx },
    {
      multiple:
        'source resolved to multiple files — environment: entries must resolve to a single scalar value',
      binary:
        'source resolved to binary content, which cannot be used as an environment variable value',
    },
  );
  return text.trim();
}
