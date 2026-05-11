import { spawnSync } from 'child_process';
import { getShellArgs } from '../shell';

export function fetchExec(command: string): Buffer {
  const { shell, args } = getShellArgs(command);
  const result = spawnSync(shell, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`exec failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `exec exited with code ${result.status}${stderr ? ': ' + stderr : ''}`,
    );
  }
  return Buffer.from(result.stdout, 'utf8');
}
