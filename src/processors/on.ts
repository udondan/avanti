import { spawnSync } from 'child_process';
import { Variables } from '../types';
import { resolveVarsShellSafe } from '../variables';
import { getShellArgs, isWindows } from '../shell';

export function applyWriteHook(
  content: string,
  script: string,
  vars: Variables = {},
): string {
  const resolvedScript = resolveVarsShellSafe(script, vars);
  const { shell, args } = getShellArgs(resolvedScript);
  const result = spawnSync(shell, args, {
    input: content,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`on.write script failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    const detail = result.signal
      ? `killed by signal ${result.signal}`
      : `exited with code ${result.status ?? 'null'}`;
    throw new Error(`on.write script ${detail}${stderr ? ': ' + stderr : ''}`);
  }
  return result.stdout;
}

// Side-effect hooks do not use avanti variable substitution — scripts are
// passed to the shell verbatim. $AVANTI_TARGET and $AVANTI_IS_NEW are
// available as process environment variables (set via extraEnv).
// On Windows, a PowerShell prelude maps those variables to local PS variables
// so that `$AVANTI_TARGET` works identically to Unix `$AVANTI_TARGET`.
export function runHook(
  script: string,
  extraEnv: Record<string, string> = {},
): void {
  let resolvedScript = script;
  if (isWindows && Object.keys(extraEnv).length > 0) {
    const prelude = Object.keys(extraEnv)
      .map((k) => `$${k} = $env:${k};`)
      .join('');
    resolvedScript = prelude + script;
  }
  const { shell, args } = getShellArgs(resolvedScript);
  const result = spawnSync(shell, args, {
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`hook script failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.signal
      ? `killed by signal ${result.signal}`
      : `exited with code ${result.status ?? 'null'}`;
    throw new Error(`hook script ${detail}`);
  }
}
