import { spawnSync } from 'child_process';
import { getShellArgs } from '../shell';
import { verbose } from '../logger';

export function fetchExec(command: string): Buffer {
  verbose(`exec: ${command}`);
  const { shell, args } = getShellArgs(command);
  const result = spawnSync(shell, args, {
    encoding: 'buffer',
    maxBuffer: 200 * 1024 * 1024,
  });
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
