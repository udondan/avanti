import { spawnSync } from 'child_process';

export function fetchExec(command: string): string {
  const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`exec failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `exec exited with code ${result.status}${stderr ? ': ' + stderr : ''}`,
    );
  }
  return result.stdout;
}
