import { Variables } from './types';

// $latest is a special sentinel used by the GitLab source to resolve the newest tag.
export const RESERVED_VARS = new Set(['latest']);

export function validateVariables(vars: Variables): void {
  for (const name of Object.keys(vars)) {
    if (RESERVED_VARS.has(name)) {
      throw new Error(`Variable name "${name}" is reserved and cannot be used`);
    }
  }
}

export function resolveVars(value: string, vars: Variables): string {
  // First pass: $env:NAME → process.env value (must come before $name pass)
  const afterEnv = value.replace(
    /\$env:([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, name: string) => {
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`Undefined environment variable: $env:${name}`);
      }
      return val;
    },
  );

  // Second pass: $name → variable value (reserved names are passed through unchanged)
  return afterEnv.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, name: string) => {
      if (RESERVED_VARS.has(name)) return match;
      if (!(name in vars)) {
        throw new Error(`Undefined variable: $${name}`);
      }
      return vars[name];
    },
  );
}

// POSIX single-quote escaping: wrap in ' and escape embedded ' as '\''
function shellQuote(val: string): string {
  return "'" + val.replace(/'/g, "'\\''") + "'";
}

// Like resolveVars but shell-quotes each substituted value, preventing
// metacharacters in variable values (especially $env: vars) from being
// interpreted by the shell. Use this when the resolved string is passed
// to sh -c (exec sources, post processors).
export function resolveVarsShellSafe(value: string, vars: Variables): string {
  const afterEnv = value.replace(
    /\$env:([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, name: string) => {
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`Undefined environment variable: $env:${name}`);
      }
      return shellQuote(val);
    },
  );

  return afterEnv.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, name: string) => {
      if (RESERVED_VARS.has(name)) return match;
      if (!(name in vars)) {
        throw new Error(`Undefined variable: $${name}`);
      }
      return shellQuote(vars[name]);
    },
  );
}
