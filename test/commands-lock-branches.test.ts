// lock: values thrown that are not Error instances and configs without
// variables (in-process, selected modules spied on).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockCommand } from '../src/commands/lock';
import * as config from '../src/config';
import * as context from '../src/context';
import * as sources from '../src/sources';
import { makeTempEnv, runCommand, TempEnv } from './commands-pull-helpers';

let env: TempEnv;

function lock() {
  return runCommand(lockCommand(), [
    '--config',
    env.configPath,
    '--working-dir',
    env.work,
    'lock',
  ]);
}

const RAW_ENTRY = `files:
  out.txt:
    src:
      - raw: x
`;

beforeEach(() => {
  env = makeTempEnv('lock-branches');
  env.writeConfig(RAW_ENTRY);
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

describe('lock: values thrown that are not errors', () => {
  it('reports a config load failure', async () => {
    vi.spyOn(config, 'loadConfig').mockRejectedValue('no config');
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no config');
  });

  it('reports a variable resolution failure', async () => {
    vi.spyOn(context, 'resolveVariablesAndEnvironment').mockRejectedValue(
      'no vars',
    );
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no vars');
  });

  it('reports a fetch failure', async () => {
    vi.spyOn(sources, 'fetchSource').mockRejectedValue('offline');
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('Error processing [{"raw":"x"}]: offline');
  });
});

describe('lock: defaults', () => {
  it('uses the current directory and a config without variables', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(env.work);
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      files: config.parseConfigContent(RAW_ENTRY).files,
    });
    const res = await runCommand(lockCommand(), [
      '--config',
      env.configPath,
      'lock',
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No SHA-pinnable remote sources found');
  });
});
