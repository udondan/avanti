import { spawnSync } from 'child_process';
import { Variables } from '../types';
import { resolveVarsShellSafe } from '../variables';
import { getShellArgs } from '../shell';

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
  if (result.status !== null && result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `on.write script exited with code ${result.status}${stderr ? ': ' + stderr : ''}`,
    );
  }
  if (result.error) {
    throw new Error(`on.write script failed to spawn: ${result.error.message}`);
  }
  return result.stdout;
}

// Side-effect hooks do not use avanti variable substitution — scripts are
// passed to the shell verbatim. $AVANTI_TARGET and $AVANTI_IS_NEW are
// available as process environment variables set via extraEnv.
export function runHook(
  script: string,
  extraEnv: Record<string, string> = {},
): void {
  const { shell, args } = getShellArgs(script);
  const result = spawnSync(shell, args, {
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.status !== null && result.status !== 0) {
    throw new Error(`hook script exited with code ${result.status}`);
  }
  if (result.error) {
    throw new Error(`hook script failed to spawn: ${result.error.message}`);
  }
}
