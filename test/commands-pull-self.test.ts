// pull: symlink entries, $self re-evaluation, remote configs and simulated
// Windows behaviour (in-process, real file system).
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullCommand } from '../src/commands/pull';
import { HistoryManager, PullLogFileRef } from '../src/history';
import { computeContentSha256 } from '../src/sha';
import { makeTempEnv, runCommand, TempEnv } from './commands-pull-helpers';

const posixOnly = it.skipIf(process.platform === 'win32');

let env: TempEnv;

function pull(...extra: string[]) {
  return runCommand(pullCommand(), [
    '--config',
    env.configPath,
    '--working-dir',
    env.work,
    'pull',
    ...extra,
  ]);
}

function w(rel: string, content: string): string {
  const p = path.join(env.work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function r(rel: string): string {
  return fs.readFileSync(path.join(env.work, rel), 'utf8');
}

/** Runs fn with process.platform reporting win32. */
async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

const WRONG_SHA = computeContentSha256('wrong');

beforeEach(() => {
  env = makeTempEnv('pull-self');
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});
describe('pull: symlink entries', () => {
  posixOnly('creates, backs up and hooks a symlink', async () => {
    const log = path.join(env.root, 'hooks.log');
    w('a.txt', 'A');
    w('b.txt', 'B');
    env.writeConfig(`files:
  link:
    src: ./a.txt
    symlink: relative
    backup: "$path.bak"
    on:
      create: echo create >> ${log}
      update: echo update >> ${log}
  copy.txt:
    src: ./link
`);
    let res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(fs.readlinkSync(path.join(env.work, 'link'))).toBe('a.txt');
    // The later entry reads through the pending symlink write.
    expect(r('copy.txt')).toBe('A');

    env.writeConfig(`files:
  link:
    src: ./b.txt
    symlink: relative
    backup: "$path.bak"
    on:
      create: echo create >> ${log}
      update: echo update >> ${log}
`);
    res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(fs.readlinkSync(path.join(env.work, 'link'))).toBe('b.txt');
    expect(fs.readFileSync(log, 'utf8')).toBe('create\nupdate\n');
  });

  posixOnly('skips a symlink entry whose optional src is missing', async () => {
    w('a.txt', 'A');
    env.writeConfig(`files:
  link:
    src:
      path: ./a.txt
      optional: true
    symlink: true
`);
    expect((await pull('--yes')).code).toBe(0);
    expect(fs.lstatSync(path.join(env.work, 'link')).isSymbolicLink()).toBe(
      true,
    );
    fs.unlinkSync(path.join(env.work, 'a.txt'));
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    // Still managed: the skipped entry protects the link from stale cleanup.
    expect(fs.lstatSync(path.join(env.work, 'link')).isSymbolicLink()).toBe(
      true,
    );
  });

  posixOnly('rejects a symlink entry whose target is a directory', async () => {
    w('a.txt', 'A');
    fs.mkdirSync(path.join(env.work, 'link'));
    env.writeConfig(`files:
  link:
    src: ./a.txt
    symlink: true
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('is a directory; cannot replace');
  });

  posixOnly('links to a directory source', async () => {
    fs.mkdirSync(path.join(env.work, 'dir'));
    env.writeConfig(`files:
  link:
    src: ./dir
    symlink: true
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(fs.lstatSync(path.join(env.work, 'link')).isSymbolicLink()).toBe(
      true,
    );
  });

  it('refuses symlink entries on Windows', async () => {
    w('a.txt', 'A');
    env.writeConfig(`files:
  link:
    src: ./a.txt
    symlink: true
`);
    const res = await asWindows(() => pull('--yes'));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('not supported on Windows');
  });
});

describe('pull: simulated Windows', () => {
  /** Reports win32 from the stale-file scan on, i.e. after the fetch loop
   *  resolved all paths with the real platform. */
  function windowsAfterFetch(): void {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const orig = Object.getOwnPropertyDescriptor(
      HistoryManager.prototype,
      'getLastPullFiles',
    )!.value as (this: HistoryManager) => PullLogFileRef[];
    vi.spyOn(HistoryManager.prototype, 'getLastPullFiles').mockImplementation(
      function (this: HistoryManager) {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        return orig.call(this);
      },
    );
    restorePlatform = () => {
      Object.defineProperty(process, 'platform', desc);
    };
  }
  let restorePlatform: (() => void) | undefined;
  afterEach(() => {
    restorePlatform?.();
    restorePlatform = undefined;
  });

  it('refuses sudo targets', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    sudo: true
`);
    windowsAfterFetch();
    const res = await pull('--yes');
    restorePlatform?.();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('sudo is not supported on Windows');
  });

  posixOnly('cannot restore a pre-avanti symlink', async () => {
    w('target.txt', 't');
    fs.symlinkSync('target.txt', path.join(env.work, 'link'));
    env.writeConfig(`files:
  link:
    src:
      - raw: replaced
`);
    expect((await pull('--yes')).code).toBe(0);
    env.writeConfig(`files: {}
`);
    windowsAfterFetch();
    const res = await pull('--yes');
    restorePlatform?.();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(
      'cannot restore pre-avanti symlink on Windows',
    );
  });
});

describe('pull: $self', () => {
  it('stabilises a self-referencing config and writes it back', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  $self:
    src:
      path: ./base.yml
  out.txt:
    src: ./src.txt
`,
    );
    env.writeConfig(`files:
  $self:
    src:
      path: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('re-evaluating with merged config');
    expect(r('out.txt')).toBe('content');
    expect(fs.readFileSync(env.configPath, 'utf8')).toContain('out.txt');
  });

  it('writes back a $self with a plain-string src', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  out.txt:
    src: ./src.txt
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
    expect(fs.readFileSync(env.configPath, 'utf8')).toContain('out.txt');
  });

  it('replaces a file entry targeting the config itself', async () => {
    w(
      'base.yml',
      `files:
  avanti.yml:
    src:
      - raw: ignored
    mode: "0644"
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    const written = fs.readFileSync(env.configPath, 'utf8');
    expect(written).toContain('avanti.yml');
    expect(written).not.toBe('ignored');
  });

  it('rejects an invalid merged config', async () => {
    w(
      'base.yml',
      `nope: 1
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('$self config is invalid');
  });

  it('rejects a $self that resolves to several files', async () => {
    w('dir/a.txt', 'a');
    w('dir/b.txt', 'b');
    env.writeConfig(`files:
  $self:
    src: ./dir/
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('$self must resolve to exactly one file');
  });

  it('aborts when the $self condition cannot be evaluated', async () => {
    delete process.env.AVANTI_TEST_UNSET_VAR;
    env.writeConfig(`files:
  $self:
    src: ./base.yml
    if:
      exists: $env:AVANTI_TEST_UNSET_VAR
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error processing $self');
  });

  it('evaluates target_exists conditions against the config path', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  out.txt:
    src: ./src.txt
    if:
      target_exists: false
`,
    );
    env.writeConfig(`files:
  $self:
    src:
      - path: ./base.yml
        if:
          target_exists: true
    if:
      target_exists: true
`);
    const res = await pull('--yes');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
  });

  it('skips $self when its condition is false', async () => {
    w('src.txt', 'content');
    env.writeConfig(`files:
  $self:
    src: ./missing.yml
    if:
      exists: ./never-there
  out.txt:
    src: ./src.txt
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
  });

  it('stops re-evaluating when the merged $self is condition-skipped', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  $self:
    src: ./base.yml
    if:
      exists: ./never-there
  out.txt:
    src: ./src.txt
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
  });

  it('aborts when the re-evaluated $self fails', async () => {
    w(
      'base.yml',
      `files:
  $self:
    src: ./missing.yml
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('errors in $self re-evaluated config');
  });

  it('aborts on a SHA mismatch in the re-evaluated $self', async () => {
    w(
      'base.yml',
      `files:
  $self:
    src:
      path: ./base.yml
      sha: ${WRONG_SHA}
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('SHA mismatch');
  });

  it('accepts SHA mismatches in the re-evaluated $self and its files', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  $self:
    src:
      path: ./base.yml
      sha: ${WRONG_SHA}
  out.txt:
    src:
      path: ./src.txt
      sha: ${WRONG_SHA}
`,
    );
    env.writeConfig(`files:
  $self:
    src:
      path: ./base.yml
      sha: ${WRONG_SHA}
`);
    const res = await pull('--yes', '--accept-changes');
    expect(res.stderr).toContain('SHA mismatch');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
  });

  it('aborts when an entry of the stable config fails', async () => {
    w(
      'base.yml',
      `files:
  out.txt:
    src: ./missing.txt
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Aborting due to errors.');
  });

  it('aborts on a SHA mismatch in the stable config', async () => {
    w('src.txt', 'content');
    w(
      'base.yml',
      `files:
  out.txt:
    src:
      path: ./src.txt
      sha: ${WRONG_SHA}
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('SHA mismatch');
  });

  it('carries a skipped entry with an unresolvable target through', async () => {
    w(
      'base.yml',
      `files:
  ../escape.txt:
    src:
      - raw: x
    if:
      exists: ./never-there
`,
    );
    env.writeConfig(`files:
  $self:
    src: ./base.yml
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('unresolvable target path');
  });
});

describe('pull: remote config', () => {
  let server: http.Server;
  let url: string;
  let body = '';

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/avanti.yml`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts SHA mismatches for the session only', async () => {
    const src = w('src.txt', 'content');
    body = `files:
  out.txt:
    src:
      path: ${JSON.stringify(src)}
      sha: ${WRONG_SHA}
`;
    const res = await runCommand(pullCommand(), [
      '--config',
      url,
      '--working-dir',
      env.work,
      'pull',
      '--yes',
      '--accept-changes',
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('config is remote; SHA values cannot');
    expect(r('out.txt')).toBe('content');
  });

  it('keeps a remote $self in memory', async () => {
    const src = w('src.txt', 'content');
    body = `files:
  $self:
    src:
      - raw: |
          files:
            out.txt:
              src: ${JSON.stringify(src)}
`;
    const res = await runCommand(pullCommand(), [
      '--config',
      url,
      '--working-dir',
      env.work,
      'pull',
      '--yes',
    ]);
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('content');
    expect(fs.existsSync(path.join(env.work, 'avanti.yml'))).toBe(false);
  });

  it('skips a condition-false $self of a remote config', async () => {
    body = `files:
  $self:
    src:
      - raw: "files: {}"
    if:
      exists: ./never-there
`;
    const res = await runCommand(pullCommand(), [
      '--config',
      url,
      '--working-dir',
      env.work,
      'pull',
      '--yes',
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
  });
});
