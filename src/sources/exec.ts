import { spawnSync } from 'child_process';
import { getShellArgs } from '../shell';

export function fetchExec(command: string): Buffer {
  const { shell, args } = getShellArgs(command);
  const result = spawnSync(shell, args, { encoding: 'buffer' });
  if (result.error) {
    throw new Error(`exec failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    throw new Error(
      `exec exited with code ${result.status}${stderr ? ': ' + stderr : ''}`,
    );
  }
  return result.stdout ?? Buffer.alloc(0);
}
