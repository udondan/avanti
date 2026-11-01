// pull: the less common arms of `avanti pull` — values thrown that are not
// Error instances, configs without variables, binary sources and other edge
// cases (in-process, real file system, selected modules spied on).
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullCommand } from '../src/commands/pull';
import * as condition from '../src/condition';
import * as config from '../src/config';
import * as writeback from '../src/config-writeback';
import * as context from '../src/context';
import * as dependencies from '../src/dependencies';
import { HistoryManager } from '../src/history';
import * as hooks from '../src/processors/on';
import { computeContentSha256 } from '../src/sha';
import * as sources from '../src/sources';
import * as writer from '../src/writer';
import {
  makeTempEnv,
  runCommand,
  TempEnv,
  throwNonError,
} from './commands-pull-helpers';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
const mockRmSync = vi.mocked(fs.rmSync);

const posixOnly = it.skipIf(process.platform === 'win32');

const WRONG_SHA = computeContentSha256('wrong');

let env: TempEnv;

function pull(...extra: string[]) {
  return runCommand(pullCommand(), [
    '--config',
    env.configPath,
    '--working-dir',
    env.work,
    'pull',
    '--yes',
    ...extra,
  ]);
}

function p(rel: string): string {
  return path.join(env.work, rel);
}

function w(rel: string, content: string | Buffer): string {
  const file = p(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function history(): HistoryManager {
  return new HistoryManager(env.configPath, env.work);
}

const RAW_ENTRY = `files:
  out.txt:
    src:
      - raw: x
`;

beforeEach(() => {
  env = makeTempEnv('pull-branches');
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  mockRmSync.mockReset().mockImplementation(actual.rmSync);
  env.cleanup();
  vi.restoreAllMocks();
});

describe('pull: values thrown that are not errors', () => {
  it('reports a config load failure', async () => {
    vi.spyOn(config, 'loadConfig').mockRejectedValue('no config');
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no config');
  });

  it('reports a variable resolution failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(context, 'resolveVariablesAndEnvironment').mockRejectedValue(
      'no vars',
    );
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('no vars');
  });

  it('reports a $self condition failure', async () => {
    env.writeConfig(`files:
  $self:
    src:
      - raw: "files: {}"
`);
    vi.spyOn(condition, 'evaluateConditions').mockImplementation(() => {
      throwNonError('bad condition');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error processing $self: bad condition');
  });

  it('reports a dependency sort failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(dependencies, 'sortByDependencies').mockImplementation(() => {
      throwNonError('no order');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('no order');
  });

  it('reports a fetch failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(sources, 'fetchSource').mockRejectedValue('offline');
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error processing [{"raw":"x"}]: offline');
  });

  it('reports an invalid merged $self config', async () => {
    env.writeConfig(`files:
  $self:
    src:
      - raw: "files: {}"
`);
    vi.spyOn(config, 'parseConfigContent').mockImplementation(() => {
      throwNonError('unparsable');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('$self config is invalid: unparsable');
  });

  it('reports a failing pre-write hook', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    on:
      beforeWrite: "true"
`);
    vi.spyOn(hooks, 'runHook').mockImplementation(() => {
      throwNonError('hook exploded');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(
      `Hook beforeWrite failed for ${p('out.txt')}: hook exploded`,
    );
    expect(fs.existsSync(p('out.txt'))).toBe(false);
  });

  it('reports a failing post-write hook and skips the remaining hooks', async () => {
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    on:
      create: "true"
  other.txt:
    src:
      - raw: y
    on:
      create: "true"
`);
    vi.spyOn(hooks, 'runHook').mockImplementation(() => {
      throwNonError('hook exploded');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(
      `Hook create failed for ${p('out.txt')}: hook exploded`,
    );
    expect(hooks.runHook).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(p('out.txt'), 'utf8')).toBe('x');
  });

  it('reports a write failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(writer, 'atomicWrite').mockImplementation(() => {
      throwNonError('EIO');
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Write failed: EIO');
  });

  it('warns when a stale file cannot be deleted', async () => {
    env.writeConfig(RAW_ENTRY);
    expect((await pull()).code).toBe(0);
    env.writeConfig('files: {}\n');
    const actual = await vi.importActual<typeof import('fs')>('fs');
    mockRmSync.mockImplementation((target, opts) => {
      if (target === p('out.txt')) throwNonError('busy');
      actual.rmSync(target, opts);
    });
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(`could not delete ${p('out.txt')}: busy`);
  });

  it('warns when the SHA writeback fails', async () => {
    w('src.txt', 'content');
    env.writeConfig(`files:
  out.txt:
    src:
      - path: ./src.txt
        sha: ${WRONG_SHA}
`);
    vi.spyOn(writeback, 'writeUpdatedShas').mockImplementation(() => {
      throwNonError('read-only');
    });
    const res = await pull('--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(
      'Warning: could not update SHA values in config: read-only',
    );
  });
});

describe('pull: defaults', () => {
  it('uses the current directory without --working-dir', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(process, 'cwd').mockReturnValue(env.work);
    const res = await runCommand(pullCommand(), [
      '--config',
      env.configPath,
      'pull',
      '--yes',
    ]);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(p('out.txt'), 'utf8')).toBe('x');
  });

  it('handles a config without variables and environment', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      files: config.parseConfigContent(RAW_ENTRY).files,
    });
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(p('out.txt'), 'utf8')).toBe('x');
  });
});

describe('pull: skipped entries', () => {
  it('protects the files of a condition-skipped directory entry', async () => {
    w('srcdir/a.txt', 'a');
    env.writeConfig(`files:
  out/:
    src: ./srcdir/
`);
    expect((await pull()).code).toBe(0);
    env.writeConfig(`files:
  out/:
    src: ./srcdir/
    if:
      exists: ./never-there
`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(fs.readFileSync(p('out/a.txt'), 'utf8')).toBe('a');
  });
});

describe('pull: content', () => {
  it('copies binary content without text processing', async () => {
    const bin = Buffer.from([0x00, 0x01, 0x24, 0x78, 0xff]);
    w('src.bin', bin);
    env.writeConfig(`variables:
  x: replaced
files:
  out.bin:
    src: ./src.bin
    replace:
      - from: $x
        to: y
`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(fs.readFileSync(p('out.bin'))).toEqual(bin);
  });
});

describe('pull: $self SHA mismatches', () => {
  it('collects mismatches of a $self source that only the merged config names', async () => {
    w('final.yml', 'files: {}\n');
    w(
      'next.yml',
      `files:
  $self:
    src:
      path: ./final.yml
      sha: ${WRONG_SHA}
`,
    );
    env.writeConfig(`files:
  $self:
    src:
      path: ./next.yml
      sha: ${WRONG_SHA}
`);
    const res = await pull('--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('final.yml');
    expect(res.stderr).toContain('next.yml');
    expect(fs.readFileSync(env.configPath, 'utf8')).toBe('files: {}\n');
  });

  it('reports a source shared by $self and a file only once', async () => {
    const base = `files:
  $self:
    src:
      path: ./base.yml
      sha: ${WRONG_SHA}
  out.yml:
    src:
      path: ./base.yml
      sha: ${WRONG_SHA}
`;
    w('base.yml', base);
    env.writeConfig(base);
    const res = await pull('--accept-changes');
    expect(res.code).toBe(0);
    expect(res.stderr.match(/SHA mismatch/g)).toHaveLength(1);
    expect(fs.existsSync(p('out.yml'))).toBe(true);
  });
});

describe('pull: stale files', () => {
  posixOnly(
    'leaves a stale pre-avanti symlink that was already restored',
    async () => {
      w('target.txt', 't');
      fs.symlinkSync('target.txt', p('link'));
      env.writeConfig(`files:
  link:
    src:
      - raw: managed
  other.txt:
    src:
      - raw: a
`);
      expect((await pull()).code).toBe(0);
      expect(history().getFileMeta(p('link'))?.v0IsSymlink).toBe(true);
      fs.rmSync(p('link'));
      fs.symlinkSync('target.txt', p('link'));
      env.writeConfig(`files:
  other.txt:
    src:
      - raw: b
`);
      const res = await pull();
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Wrote 1 file(s).');
      expect(fs.readlinkSync(p('link'))).toBe('target.txt');
    },
  );

  it('records a partial write that only restored a stale file', async () => {
    w('a.txt', 'orig');
    env.writeConfig(`files:
  a.txt:
    src:
      - raw: managed
`);
    expect((await pull()).code).toBe(0);
    env.writeConfig('files: {}\n');
    vi.spyOn(writer, 'atomicWrite').mockImplementation(() => {
      throw new writer.AtomicWritePartialError('disk full', [p('a.txt')]);
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(history().getLastPullFiles()).toEqual([]);
  });

  it('records nothing when the partial write names no tracked file', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(writer, 'atomicWrite').mockImplementation(() => {
      throw new writer.AtomicWritePartialError('disk full', [p('else.txt')]);
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(history().getLastPullFiles()).toEqual([]);
  });

  it('reports a write failure without history storage', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(HistoryManager.prototype, 'ensureStorageDir').mockReturnValue(
      false,
    );
    vi.spyOn(writer, 'atomicWrite').mockImplementation(() => {
      throw new writer.AtomicWritePartialError('disk full', [p('out.txt')]);
    });
    const res = await pull();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Write failed: disk full');
  });
});

describe('pull: mode changes', () => {
  posixOnly('skips the chmod of a file a hook removed', async () => {
    w('out.txt', 'x');
    fs.chmodSync(p('out.txt'), 0o644);
    env.writeConfig(`files:
  out.txt:
    src:
      - raw: x
    mode: "0600"
    on:
      beforeWrite: rm "$AVANTI_TARGET"
`);
    const res = await pull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do.');
    expect(fs.existsSync(p('out.txt'))).toBe(false);
  });
});
