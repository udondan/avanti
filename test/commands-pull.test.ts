import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullCommand } from '../src/commands/pull';
import { HistoryManager } from '../src/history';
import { computeContentSha256 } from '../src/sha';
import { makeTempEnv, runCommand, TempEnv } from './commands-pull-helpers';

vi.mock('../src/prompt', () => ({ confirm: vi.fn() }));
import { confirm } from '../src/prompt';
const mockConfirm = vi.mocked(confirm);

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

function sha(content: string): string {
  // Single-file sources hash the file map; compute via a dry pull instead when
  // the exact algorithm matters. This helper is only used for "wrong" SHAs.
  return computeContentSha256(content);
}

beforeEach(() => {
  env = makeTempEnv('pull');
  mockConfirm.mockReset();
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

describe('pull: config and fetch errors', () => {
  it('exits 2 when the config cannot be loaded', async () => {
    const res = await runCommand(pullCommand(), [
      '--config',
      path.join(env.work, 'missing.yml'),
      '--working-dir',
      env.work,
      'pull',
      '--yes',
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).not.toBe('');
  });

  it('aborts when a variable cannot be resolved', async () => {
    env.writeConfig(`variables:
  broken:
    src: ./does-not-exist.txt
files:
  out.txt:
    src:
      - raw: hello
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Aborting due to errors.');
  });

  it('aborts on a circular local dependency', async () => {
    env.writeConfig(`files:
  a.txt:
    src: ./b.txt
  b.txt:
    src: ./a.txt
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Circular dependency');
  });

  it('reports a per-entry fetch error and aborts', async () => {
    env.writeConfig(`files:
  out.txt:
    src: ./nope.txt
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error processing');
    expect(res.stderr).toContain('Aborting due to errors.');
  });
});

describe('pull: skipped entries', () => {
  it('warns when a condition-skipped entry has an unresolvable target', async () => {
    env.writeConfig(`files:
  ../escape.txt:
    src:
      - raw: x
    if:
      exists: ./never-there
  ok.txt:
    src:
      - raw: ok
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('unresolvable target path');
    expect(r('ok.txt')).toBe('ok');
  });

  posixOnly(
    'protects the real path of a skipped followSymlink entry',
    async () => {
      w('real.txt', 'real');
      fs.symlinkSync('real.txt', path.join(env.work, 'link.txt'));
      env.writeConfig(`files:
  link.txt:
    src:
      - raw: content
    followSymlink: true
`);
      expect((await pull('--yes')).code).toBe(0);
      expect(r('real.txt')).toBe('content');

      env.writeConfig(`files:
  link.txt:
    src:
      - raw: content
    followSymlink: true
    if:
      exists: ./never-there
`);
      const res = await pull('--yes');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Nothing to do.');
      expect(r('real.txt')).toBe('content');
    },
  );

  it('treats a missing optional source as skipped', async () => {
    env.writeConfig(`files:
  ../escape.txt:
    src:
      path: ./missing.txt
      optional: true
  out.txt:
    src:
      path: ./missing.txt
      optional: true
  dir/:
    src:
      path: ./missing-dir/
      optional: true
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('unresolvable target path');
  });

  posixOnly(
    'protects the real path of a skipped optional followSymlink entry',
    async () => {
      w('real.txt', 'real');
      w('src.txt', 'from-src');
      fs.symlinkSync('real.txt', path.join(env.work, 'link.txt'));
      env.writeConfig(`files:
  link.txt:
    src:
      path: ./src.txt
      optional: true
    followSymlink: true
`);
      expect((await pull('--yes')).code).toBe(0);
      expect(r('real.txt')).toBe('from-src');
      fs.unlinkSync(path.join(env.work, 'src.txt'));
      const res = await pull('--yes');
      expect(res.code).toBe(0);
      expect(r('real.txt')).toBe('from-src');
    },
  );
});

describe('pull: processors and hooks', () => {
  posixOnly(
    'runs template, replace, write hook and lifecycle hooks',
    async () => {
      const log = path.join(env.root, 'hooks.log');
      env.writeConfig(`variables:
  name: world
files:
  out.txt:
    src:
      - raw: "hello {{ name }} FOO"
    template: liquidjs
    replace:
      - from: FOO
        to: BAR
    on:
      write: tr a-z A-Z
      beforeWrite: echo beforeWrite >> ${log}
      beforeCreate: echo beforeCreate-$AVANTI_IS_NEW >> ${log}
      beforeUpdate: echo beforeUpdate >> ${log}
      create: echo create >> ${log}
      update: echo update >> ${log}
`);
      let res = await pull('--yes');
      expect(res.stderr).toBe('');
      expect(res.code).toBe(0);
      expect(r('out.txt')).toBe('HELLO WORLD BAR');
      w('out.txt', 'changed');
      res = await pull('--yes');
      expect(res.code).toBe(0);
      expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([
        'beforeWrite',
        'beforeCreate-true',
        'create',
        'beforeWrite',
        'beforeUpdate',
        'update',
      ]);
    },
  );

  posixOnly('exits 2 when a before hook fails', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    on:
      beforeWrite: exit 3
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Hook beforeWrite failed');
    expect(fs.existsSync(path.join(env.work, 'out.txt'))).toBe(false);
  });

  posixOnly('reports a failing post-write hook after writing', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    on:
      create: exit 4
      update: echo never
`);
    const res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Hook create failed');
    expect(r('out.txt')).toBe('x');
  });

  it('writes a backup when an existing file changes', async () => {
    w('out.txt', 'old');
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: new
    backup: "$path.bak"
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('new');
    expect(r('out.txt.bak')).toBe('old');
  });
});

describe('pull: insert strategy', () => {
  it('skips the write when the inserted fragment is unchanged', async () => {
    w('host.txt', 'line1\nline2\n');
    env.writeConfig(`files:
  host.txt:
    src:
      - raw: "inserted"
    strategy: insert
`);
    let res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('host.txt')).toContain('inserted');
    res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
  });

  posixOnly('tracks insert fragments through followSymlink', async () => {
    w('real.txt', 'base\n');
    fs.symlinkSync('real.txt', path.join(env.work, 'link.txt'));
    env.writeConfig(`files:
  link.txt:
    src:
      - raw: "frag"
    strategy: insert
    followSymlink: true
`);
    expect((await pull('--yes')).code).toBe(0);
    expect(r('real.txt')).toContain('frag');
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
  });

  it('saves the fragment when the file already holds the inserted JSON', async () => {
    w('host.json', '{\n  "a": 1\n}\n');
    env.writeConfig(`files:
  host.json:
    src:
      - raw: '{"a": 1}'
    strategy: insert
    json: true
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    const h = new HistoryManager(env.configPath, env.work);
    expect(
      h.getInsertedFragment(path.join(env.work, 'host.json')),
    ).not.toBeNull();
  });

  it('removes only the INI values the previous pull added', async () => {
    w('host.ini', '[s]\nlist[] = a\n');
    const config = (raw: string) => `files:
  host.ini:
    src:
      - raw: "${raw}"
    strategy: insert
    ini:
      arrays: concat
`;
    env.writeConfig(config('[s]\\nlist[] = a\\nlist[] = b\\n'));
    expect((await pull('--yes')).code).toBe(0);
    expect(r('host.ini')).toBe('[s]\nlist[] = a\nlist[] = a\nlist[] = b\n');
    const h = new HistoryManager(env.configPath, env.work);
    expect(
      h.getInsertedFragment(path.join(env.work, 'host.ini'))?.owned,
    ).toEqual({
      format: 'ini',
      globals: [],
      sections: [
        {
          name: 's',
          index: 0,
          created: false,
          kvs: [{ key: 'list', isArray: true, value: ['a', 'b'] }],
        },
      ],
    });
    env.writeConfig(config('[t]\\nk = 1\\n'));
    expect((await pull('--yes')).code).toBe(0);
    expect(r('host.ini')).toBe('[s]\nlist[] = a\n[t]\nk = 1\n');
  });
});

describe('pull: prompt', () => {
  it('applies after a yes answer and aborts after no', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    mockConfirm.mockResolvedValueOnce(false);
    let res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Aborted.');
    expect(fs.existsSync(path.join(env.work, 'out.txt'))).toBe(false);

    mockConfirm.mockResolvedValueOnce(true);
    res = await pull();
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('x');
    expect(mockConfirm).toHaveBeenLastCalledWith('Apply changes? [y/N] ');
  });

  it('rethrows prompt errors', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    mockConfirm.mockRejectedValueOnce(new Error('stdin closed'));
    const res = await pull();
    expect((res.thrown as Error).message).toBe('stdin closed');
  });
});

describe('pull: SHA pins', () => {
  it('aborts on a mismatch and accepts it with --accept-changes', async () => {
    w('src.txt', 'content');
    const wrong = sha('wrong');
    env.writeConfig(`files:
  out.txt:
    src:
      - path: ./src.txt
        sha: ${wrong}
`);
    let res = await pull('--yes');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('SHA mismatch');
    expect(res.stderr).toContain('--accept-changes');

    mockConfirm.mockResolvedValueOnce(true);
    res = await pull('--accept-changes');
    expect(res.code).toBe(0);
    expect(mockConfirm).toHaveBeenCalledWith(
      'Accept new SHA values and apply changes? [y/N] ',
    );
    expect(res.stdout).toContain('Updated 1 SHA pin(s) in config.');
    expect(fs.readFileSync(env.configPath, 'utf8')).not.toContain(wrong);
    expect(r('out.txt')).toBe('content');

    // Pinned now: no mismatch, nothing to do.
    res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
  });

  it('records the accepted SHA even when the file content is unchanged', async () => {
    w('src.txt', 'content');
    w('out.txt', 'content');
    env.writeConfig(`files:
  out.txt:
    src:
      - path: ./src.txt
        sha: ${sha('wrong')}
`);
    const res = await pull('--yes', '--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('SHA mismatch');
    expect(res.stdout).toContain('Updated 1 SHA pin(s) in config.');
  });

  it('warns when the SHA writeback fails', async () => {
    w('src.txt', 'content');
    env.writeConfig(`files:
  out.txt:
    src:
      - path: ./src.txt
        sha: ${sha('wrong')}
`);
    const writeback = await import('../src/config-writeback');
    vi.spyOn(writeback, 'writeUpdatedShas').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await pull('--yes', '--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(
      'Warning: could not update SHA values in config: disk full',
    );
  });
});

describe('pull: stale files', () => {
  it('deletes stale files and prunes already-gone stale refs', async () => {
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
  b.txt:
    src:
      - raw: b
  c.txt:
    src:
      - raw: c
`);
    expect((await pull('--yes')).code).toBe(0);
    // b.txt disappears from the config and is still on disk -> deleted.
    // c.txt disappears from the config and was removed manually -> no-op.
    fs.unlinkSync(path.join(env.work, 'c.txt'));
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
`);
    let res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(env.work, 'b.txt'))).toBe(false);

    // Next pull: nothing stale is left.
    res = await pull('--yes');
    expect(res.stdout).toContain('Nothing to do.');
  });

  it('prunes no-op stale refs when nothing else changes', async () => {
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
  b.txt:
    src:
      - raw: b
`);
    expect((await pull('--yes')).code).toBe(0);
    fs.unlinkSync(path.join(env.work, 'b.txt'));
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    const h = new HistoryManager(env.configPath, env.work);
    expect(
      h.getLastPullFiles().map((f) => path.basename(f.absolutePath)),
    ).toEqual(['a.txt']);
  });

  it('prunes a stale restore whose file already matches the original', async () => {
    w('b.txt', 'orig');
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
  b.txt:
    src:
      - raw: b
`);
    expect((await pull('--yes')).code).toBe(0);
    w('b.txt', 'orig');
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: a
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    const h = new HistoryManager(env.configPath, env.work);
    expect(
      h.getLastPullFiles().map((f) => path.basename(f.absolutePath)),
    ).toEqual(['a.txt']);
  });

  it('restores the pre-avanti original of a stale file', async () => {
    w('a.txt', 'original');
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: managed
`);
    expect((await pull('--yes')).code).toBe(0);
    env.writeConfig(`files: {}
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('a.txt')).toBe('original');
  });

  it('warns when v0 of a stale pre-existing file is missing', async () => {
    w('a.txt', 'original');
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: managed
  b.txt:
    src:
      - raw: b
`);
    expect((await pull('--yes')).code).toBe(0);
    const h = new HistoryManager(env.configPath, env.work);
    vi.spyOn(HistoryManager.prototype, 'readVersion').mockReturnValue(null);
    expect(
      h.getFileMeta(path.join(env.work, 'a.txt'))?.existedBeforeAvanti,
    ).toBe(true);
    env.writeConfig(`files:
  b.txt:
    src:
      - raw: b
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('v0 was never captured');
  });

  posixOnly('restores a pre-avanti symlink', async () => {
    w('target.txt', 't');
    fs.symlinkSync('target.txt', path.join(env.work, 'link'));
    env.writeConfig(`files:
  link:
    src:
      - raw: replaced
`);
    expect((await pull('--yes')).code).toBe(0);
    expect(fs.lstatSync(path.join(env.work, 'link')).isSymbolicLink()).toBe(
      false,
    );
    env.writeConfig(`files: {}
`);
    let res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(fs.readlinkSync(path.join(env.work, 'link'))).toBe('target.txt');
    // Already restored: the stale symlink diff has no changes.
    res = await pull('--yes');
    expect(res.code).toBe(0);
  });

  posixOnly(
    'refuses to restore a pre-avanti symlink over a directory',
    async () => {
      w('target.txt', 't');
      fs.symlinkSync('target.txt', path.join(env.work, 'link'));
      env.writeConfig(`files:
  link:
    src:
      - raw: replaced
`);
      expect((await pull('--yes')).code).toBe(0);
      fs.unlinkSync(path.join(env.work, 'link'));
      fs.mkdirSync(path.join(env.work, 'link'));
      env.writeConfig(`files: {}
`);
      const res = await pull('--yes');
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('cannot restore symlink over directory');
    },
  );
});

describe('pull: mode changes', () => {
  posixOnly('chmods a file whose content already matches', async () => {
    w('out.txt', 'x');
    fs.chmodSync(path.join(env.work, 'out.txt'), 0o644);
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    mode: "0600"
`);
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Wrote 1 file(s).');
    expect(fs.statSync(path.join(env.work, 'out.txt')).mode & 0o777).toBe(
      0o600,
    );
  });
});

describe('pull: history failures', () => {
  it('warns when a file version cannot be staged', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    vi.spyOn(HistoryManager.prototype, 'stageFileVersion').mockImplementation(
      () => {
        throw new Error('nope');
      },
    );
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('could not record history');
    expect(r('out.txt')).toBe('x');
  });

  it('warns when the pull session cannot be saved', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    vi.spyOn(HistoryManager.prototype, 'closePullSession').mockImplementation(
      () => {
        throw new Error('nope');
      },
    );
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('Warning: could not save pull history.');
  });

  it('works without history storage', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
`);
    vi.spyOn(HistoryManager.prototype, 'ensureStorageDir').mockReturnValue(
      false,
    );
    const res = await pull('--yes');
    expect(res.code).toBe(0);
    expect(r('out.txt')).toBe('x');
  });
});
