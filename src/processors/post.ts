import { spawnSync } from 'child_process';
import { Variables } from '../types';
import { resolveVarsShellSafe } from '../variables';

const isWindows = process.platform === 'win32';

export function applyPost(
  content: string,
  script: string,
  vars: Variables = {},
): string {
  const resolvedScript = resolveVarsShellSafe(script, vars);
  const result = spawnSync(
    isWindows ? 'cmd.exe' : 'sh',
    [isWindows ? '/c' : '-c', resolvedScript],
    { input: content, encoding: 'utf8' },
  );
  if (result.status !== null && result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `post script exited with code ${result.status}${stderr ? ': ' + stderr : ''}`,
    );
  }
  if (result.error) {
    throw new Error(`post script failed to spawn: ${result.error.message}`);
  }
  return result.stdout;
}
