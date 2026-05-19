import { Variables, VariableSpec } from './types';

// $latest is a special sentinel used by the GitLab source to resolve the newest tag.
export const RESERVED_VARS = new Set(['latest']);

// Names users cannot define as variables (passthrough-reserved + system-injected).
export const RESERVED_VAR_NAMES = new Set([...RESERVED_VARS, 'self']);

export function validateVariables(vars: Variables | VariableSpec): void {
  for (const name of Object.keys(vars)) {
    if (RESERVED_VAR_NAMES.has(name)) {
      throw new Error(`Variable name "${name}" is reserved and cannot be used`);
    }
  }
}

// Single-pass regex: $$ → literal $, then $env:NAME, then $name.
// Ordering within the alternation matters: $$ must come first so it is
// consumed before the $name branch can match the second $.
const TOKEN = /\$\$|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function resolveVars(value: string, vars: Variables): string {
  return value.replace(
    TOKEN,
    (match, envName: string | undefined, varName: string | undefined) => {
      if (match === '$$') return '$';
      if (envName !== undefined) {
        const val = process.env[envName];
        if (val === undefined) {
          throw new Error(`Undefined environment variable: $env:${envName}`);
        }
        return val;
      }
      if (RESERVED_VARS.has(varName!)) return match;
      if (!(varName! in vars)) {
        throw new Error(`Undefined variable: $${varName}`);
      }
      return vars[varName!];
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
    (match, envName: string | undefined, varName: string | undefined) => {
      if (match === '$$') return '$';
      if (envName !== undefined) {
        const val = process.env[envName];
        if (val === undefined) {
          throw new Error(`Undefined environment variable: $env:${envName}`);
        }
        return shellQuote(val);
      }
      if (RESERVED_VARS.has(varName!)) return match;
      if (!(varName! in vars)) {
        throw new Error(`Undefined variable: $${varName}`);
      }
      return shellQuote(vars[varName!]);
    },
  );
}
