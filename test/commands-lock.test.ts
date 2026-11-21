import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockCommand } from '../src/commands/lock';
import { computeContentSha256 } from '../src/sha';
import { makeTempEnv, runCommand, TempEnv } from './commands-pull-helpers';

let env: TempEnv;

function lock(...extra: string[]) {
  return runCommand(lockCommand(), [
    '--config',
    env.configPath,
    '--working-dir',
    env.work,
    'lock',
    ...extra,
  ]);
}

function w(rel: string, content: string): string {
  const p = path.join(env.work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function config(): string {
  return fs.readFileSync(env.configPath, 'utf8');
}

const SHA_LINE = /sha: ([0-9a-f]{64})/g;

beforeEach(() => {
  env = makeTempEnv('lock');
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

describe('lock: errors', () => {
  it('requires a local config', async () => {
    const res = await runCommand(lockCommand(), [
      '--config',
      'https://example.invalid/avanti.yml',
      'lock',
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('avanti lock requires a local config file.');
  });

  it('exits 2 when the config cannot be loaded', async () => {
    const res = await runCommand(lockCommand(), [
      '--config',
      path.join(env.work, 'missing.yml'),
      'lock',
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).not.toBe('');
  });

  it('exits 2 when variables cannot be resolved', async () => {
    env.writeConfig(`variables:
  v:
    src: ./missing.txt
files: {}
`);
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).not.toBe('');
  });

  it('exits 2 when a source fails and nothing can be pinned', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      path: ./missing.txt
`);
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error processing');
  });

  it('aborts without writing when one of several sources fails', async () => {
    w('a.txt', 'a');
    const cfg = `files:
  a.txt:
    src:
      path: ./a.txt
  b.txt:
    src:
      path: ./missing.txt
`;
    env.writeConfig(cfg);
    const res = await lock();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Aborting: one or more sources failed');
    expect(config()).toBe(cfg);
  });
});

describe('lock: pinning', () => {
  it('reports when there is nothing pinnable', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    const res = await lock();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      'No SHA-pinnable remote sources found in config.',
    );
  });

  it('pins path and exec sources', async () => {
    w('a.txt', 'a');
    env.writeConfig(`files:
  a.txt:
    src:
      path: ./a.txt
  b.txt:
    src:
      exec: echo b
`);
    const res = await lock();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Pinned 2 source(s).');
    expect(res.stdout).toContain('  pinned  ');
    expect([...config().matchAll(SHA_LINE)]).toHaveLength(2);
  });

  it('leaves existing pins alone without --force', async () => {
    w('a.txt', 'a');
    env.writeConfig(`files:
  a.txt:
    src:
      path: ./a.txt
`);
    expect((await lock()).code).toBe(0);
    const res = await lock();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      'All remote sources already have SHA values pinned. Use --force to overwrite.',
    );
  });

  it('overwrites stale pins with --force', async () => {
    w('a.txt', 'a');
    const wrong = computeContentSha256('wrong');
    env.writeConfig(`files:
  a.txt:
    src:
      path: ./a.txt
      sha: ${wrong}
`);
    const res = await lock('--force');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Pinned 1 source(s).');
    expect(config()).not.toContain(wrong);
  });

  it('reports up-to-date pins with --force', async () => {
    w('a.txt', 'a');
    env.writeConfig(`files:
  a.txt:
    src:
      path: ./a.txt
`);
    expect((await lock()).code).toBe(0);
    const res = await lock('--force');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('All SHA values are already up to date.');
  });

  it('skips condition-false entries and evaluates $self conditions', async () => {
    w('a.txt', 'a');
    w('base.yml', 'files: {}\n');
    env.writeConfig(`files:
  $self:
    src:
      - path: ./base.yml
        if:
          target_exists: true
    if:
      target_exists: true
  a.txt:
    src:
      path: ./a.txt
    if:
      target_exists: false
`);
    const res = await lock();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Pinned 1 source(s).');
    expect(config()).toMatch(/base\.yml\n\s+if:[\s\S]*sha: [0-9a-f]{64}/);
  });

  it('defaults the working dir to the current directory', async () => {
    w('a.txt', 'a');
    env.writeConfig(`files:
  a.txt:
    src:
      path: ./a.txt
    if:
      exists: ./a.txt
`);
    vi.spyOn(process, 'cwd').mockReturnValue(env.work);
    const res = await runCommand(lockCommand(), [
      '--config',
      env.configPath,
      'lock',
    ]);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Pinned 1 source(s).');
  });
});
