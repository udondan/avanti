import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../src/sources/github', () => ({
  fetchGitHub: vi.fn(),
  fetchGitHubRelease: vi.fn(),
}));
vi.mock('../src/sources/gitlab', () => ({
  fetchGitLab: vi.fn(),
  fetchGitLabRelease: vi.fn(),
}));
vi.mock('../src/sources/bitbucket', () => ({ fetchBitbucket: vi.fn() }));
vi.mock('../src/sources/s3', () => ({ fetchS3: vi.fn() }));
vi.mock('../src/sources/secrets-manager', () => ({
  fetchSecretsManager: vi.fn(),
}));
vi.mock('../src/sources/ssm', () => ({ fetchSsm: vi.fn() }));
vi.mock('../src/sources/vault', () => ({ fetchVault: vi.fn() }));
vi.mock('../src/sources/exec', () => ({ fetchExec: vi.fn() }));
vi.mock('../src/sources/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/git')>()),
  fetchGit: vi.fn(),
}));
vi.mock('../src/sources/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/http')>()),
  fetchHttp: vi.fn(),
}));
vi.mock('../src/extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/extract')>()),
  extractArchive: vi.fn(),
}));

import {
  fetchSource,
  formatSourceLabel,
  _testable,
  type FetchCache,
} from '../src/sources';
import type { FileEntry, FileSrc } from '../src/types';
import { setVerbose } from '../src/logger';
import { fetchGitHub, fetchGitHubRelease } from '../src/sources/github';
import { fetchGitLab, fetchGitLabRelease } from '../src/sources/gitlab';
import { fetchBitbucket } from '../src/sources/bitbucket';
import { fetchS3 } from '../src/sources/s3';
import { fetchSecretsManager } from '../src/sources/secrets-manager';
import { fetchSsm } from '../src/sources/ssm';
import { fetchVault } from '../src/sources/vault';
import { fetchExec } from '../src/sources/exec';
import { fetchGit } from '../src/sources/git';
import { fetchHttp, inferFilenameFromUrl } from '../src/sources/http';
import { extractArchive } from '../src/extract';

const { srcFilename } = _testable;

function filesOf(entries: Record<string, string | Buffer>): {
  files: Map<string, Buffer>;
} {
  return {
    files: new Map(
      Object.entries(entries).map(([k, v]) => [
        k,
        typeof v === 'string' ? Buffer.from(v, 'utf8') : v,
      ]),
    ),
  };
}

const ONE_FILE = (): { files: Map<string, Buffer> } =>
  filesOf({ 'a.txt': 'content' });

function asMock(fn: unknown): MockInstance {
  return fn as MockInstance;
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-sources-index-'));
  for (const fn of [
    fetchGitHub,
    fetchGitHubRelease,
    fetchGitLab,
    fetchGitLabRelease,
    fetchBitbucket,
    fetchS3,
    fetchSecretsManager,
    fetchSsm,
    fetchVault,
  ]) {
    asMock(fn).mockImplementation(() => Promise.resolve(ONE_FILE()));
  }
  asMock(fetchGit).mockImplementation(ONE_FILE);
  asMock(fetchExec).mockReturnValue(Buffer.from('exec output'));
  asMock(fetchHttp).mockResolvedValue(Buffer.from('http body'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  setVerbose(false);
  vi.restoreAllMocks();
});

function entry(
  src: FileSrc | FileSrc[],
  extra: Partial<FileEntry> = {},
): FileEntry {
  return { src, target: 'out.txt', ...extra };
}

// ── srcFilename ───────────────────────────────────────────────────────────────

describe('srcFilename', () => {
  it.each<[string, FileSrc, string | null]>([
    ['unparseable http string', 'http://', 'http://'],
    [
      'git remote string without // file separator',
      'git+ssh://git@host/repo.git',
      'git+ssh://git@host/repo.git',
    ],
    [
      'secrets manager ARN',
      {
        aws_secrets_manager: {
          name: 'arn:aws:secretsmanager:eu-west-1:1:secret:app/conf.json',
        },
      },
      'conf.json',
    ],
    ['secrets manager empty name', { aws_secrets_manager: { name: '' } }, null],
    [
      'ssm parameter',
      { aws_systems_manager_parameter: { name: '/app/conf.yaml' } },
      '/app/conf.yaml',
    ],
    ['http object', { http: 'https://example.com/a.json' }, '/a.json'],
    ['http object with variable URL', { http: '$url' }, '$url'],
    [
      'url object with invalid git remote',
      { url: 'git+ssh://git@host/repo.git' },
      'git+ssh://git@host/repo.git',
    ],
    ['url object with variable URL', { url: '$u' }, '$u'],
    ['exec', { exec: 'echo hi' }, null],
    ['github release', { github: { repo: 'o/r', release: 'v1' } }, null],
    ['gitlab release', { gitlab: { project: 'g/p', release: 'v1' } }, null],
  ])('%s', (_desc, src, expected) => {
    expect(srcFilename(src)).toBe(expected);
  });
});

describe('inferFilenameFromUrl', () => {
  it('returns undefined for an unparseable URL', () => {
    expect(inferFilenameFromUrl('not a url')).toBeUndefined();
  });
});

describe('formatSourceLabel', () => {
  it('replaces the internal NUL filter separator', () => {
    expect(formatSourceLabel('x\x00filter:["a"]')).toBe('x | filter:["a"]');
  });
});

// ── Labels, cache keys, expected SHAs and dispatch ────────────────────────────

describe('fetchSource — per-source-type labels, cache keys and dispatch', () => {
  const vars = { v: 'X', empty: '' };

  it.each<[string, FileSrc, string, string, () => void]>([
    [
      'github file with host, ref and via',
      {
        github: {
          repo: 'o/$v',
          file: 'a.txt',
          ref: 'main',
          host: 'gh.example',
          via: 'cli',
          sha: 'abc',
        },
      },
      'github[gh.example]:o/$v:a.txt@main',
      'github[gh.example]:o/X:a.txt@main(cli)',
      () =>
        expect(fetchGitHub).toHaveBeenCalledWith(
          'o/X',
          'a.txt',
          'main',
          'gh.example',
          'cli',
        ),
    ],
    [
      'github file without host or ref',
      { github: { repo: 'o/r', file: 'a.txt' } },
      'github:o/r:a.txt',
      'github:o/r:a.txt',
      () =>
        expect(fetchGitHub).toHaveBeenCalledWith(
          'o/r',
          'a.txt',
          undefined,
          undefined,
          undefined,
        ),
    ],
    [
      'github release with host, via list and filter',
      {
        github: {
          repo: 'o/r',
          release: 'v1',
          host: 'gh.example',
          via: ['api'],
          sha: 'abc',
        },
        filter: ['*.txt'],
      },
      'github[gh.example]:o/r:release:v1\x00filter:["*.txt"]',
      'github[gh.example]:o/r:release:v1(api)\x00filter:["*.txt"]',
      () =>
        expect(fetchGitHubRelease).toHaveBeenCalledWith(
          'o/r',
          'v1',
          'gh.example',
          ['api'],
          ['*.txt'],
        ),
    ],
    [
      'github release without host or filter',
      { github: { repo: 'o/r', release: 'v1' } },
      'github:o/r:release:v1',
      'github:o/r:release:v1',
      () =>
        expect(fetchGitHubRelease).toHaveBeenCalledWith(
          'o/r',
          'v1',
          undefined,
          undefined,
          undefined,
        ),
    ],
    [
      'gitlab file with host, ref and via',
      {
        gitlab: {
          project: 'g/$v',
          file: 'a.txt',
          ref: 'main',
          host: 'gl.example',
          via: 'api',
          sha: 'abc',
        },
      },
      'gitlab[gl.example]:g/$v:a.txt@main',
      'gitlab[gl.example]:g/X:a.txt@main(api)',
      () =>
        expect(fetchGitLab).toHaveBeenCalledWith(
          'g/X',
          'a.txt',
          'main',
          'gl.example',
          'api',
        ),
    ],
    [
      'gitlab file without host or ref',
      { gitlab: { project: 'g/p', file: 'a.txt' } },
      'gitlab:g/p:a.txt',
      'gitlab:g/p:a.txt',
      () =>
        expect(fetchGitLab).toHaveBeenCalledWith(
          'g/p',
          'a.txt',
          undefined,
          undefined,
          undefined,
        ),
    ],
    [
      'gitlab release with host, via list and filter',
      {
        gitlab: {
          project: 'g/p',
          release: 'v1',
          host: 'gl.example',
          via: ['cli'],
          sha: 'abc',
        },
        filter: ['*.txt'],
      },
      'gitlab[gl.example]:g/p:release:v1\x00filter:["*.txt"]',
      'gitlab[gl.example]:g/p:release:v1(cli)\x00filter:["*.txt"]',
      () =>
        expect(fetchGitLabRelease).toHaveBeenCalledWith(
          'g/p',
          'v1',
          'gl.example',
          ['cli'],
          ['*.txt'],
        ),
    ],
    [
      'gitlab release without host or filter',
      { gitlab: { project: 'g/p', release: 'v1' } },
      'gitlab:g/p:release:v1',
      'gitlab:g/p:release:v1',
      () =>
        expect(fetchGitLabRelease).toHaveBeenCalledWith(
          'g/p',
          'v1',
          undefined,
          undefined,
          undefined,
        ),
    ],
    [
      'bitbucket with ref and host',
      {
        bitbucket: {
          workspace: 'ws',
          repo: 'r',
          file: 'a.txt',
          ref: '$v',
          host: 'bb.example',
          sha: 'abc',
        },
      },
      'bitbucket[bb.example]:ws/r:a.txt@$v',
      'bitbucket[bb.example]:ws/r:a.txt@X',
      () =>
        expect(fetchBitbucket).toHaveBeenCalledWith(
          'ws',
          'r',
          'a.txt',
          'X',
          'bb.example',
        ),
    ],
    [
      'bitbucket without ref or host',
      { bitbucket: { workspace: 'ws', repo: 'r', file: 'a.txt' } },
      'bitbucket:ws/r:a.txt',
      'bitbucket:ws/r:a.txt',
      () =>
        expect(fetchBitbucket).toHaveBeenCalledWith(
          'ws',
          'r',
          'a.txt',
          undefined,
          undefined,
        ),
    ],
    [
      'git with ref',
      {
        git: {
          repo: 'https://h/r.git',
          file: 'a.txt',
          ref: 'main',
          sha: 'abc',
        },
      },
      'git:https://h/r.git:a.txt@main',
      'git:https://h/r.git:a.txt@main',
      () =>
        expect(fetchGit).toHaveBeenCalledWith(
          'https://h/r.git',
          'a.txt',
          'main',
        ),
    ],
    [
      'git without ref',
      { git: { repo: 'https://h/r.git', file: 'a.txt' } },
      'git:https://h/r.git:a.txt',
      'git:https://h/r.git:a.txt',
      () =>
        expect(fetchGit).toHaveBeenCalledWith(
          'https://h/r.git',
          'a.txt',
          undefined,
        ),
    ],
    [
      'exec',
      { exec: 'echo $v', sha: 'abc' },
      'exec:echo $v',
      'exec:echo X',
      () => expect(fetchExec).toHaveBeenCalledWith("echo 'X'"),
    ],
    [
      'aws_s3',
      { aws_s3: 's3://b/$v', sha: 'abc' },
      'aws_s3:s3://b/$v',
      'aws_s3:s3://b/X',
      () => expect(fetchS3).toHaveBeenCalledWith('s3://b/X'),
    ],
    [
      'secrets manager with key and region',
      {
        aws_secrets_manager: {
          name: 'n',
          key: 'k',
          region: 'eu-west-1',
          sha: 'abc',
        },
      },
      'aws_secrets_manager:n#k@eu-west-1',
      'aws_secrets_manager:n#k@eu-west-1',
      () =>
        expect(fetchSecretsManager).toHaveBeenCalledWith('n', 'k', 'eu-west-1'),
    ],
    [
      'secrets manager with key and region resolving to empty',
      { aws_secrets_manager: { name: 'n', key: '$empty', region: '$empty' } },
      'aws_secrets_manager:n#$empty@$empty',
      'aws_secrets_manager:n#@',
      () =>
        expect(fetchSecretsManager).toHaveBeenCalledWith(
          'n',
          undefined,
          undefined,
        ),
    ],
    [
      'secrets manager without key or region',
      { aws_secrets_manager: { name: 'n' } },
      'aws_secrets_manager:n',
      'aws_secrets_manager:n',
      () =>
        expect(fetchSecretsManager).toHaveBeenCalledWith(
          'n',
          undefined,
          undefined,
        ),
    ],
    [
      'ssm parameter with region',
      {
        aws_systems_manager_parameter: {
          name: '/p',
          region: 'eu-west-1',
          sha: 'abc',
        },
      },
      'aws_systems_manager_parameter:/p@eu-west-1',
      'aws_systems_manager_parameter:/p@eu-west-1',
      () => expect(fetchSsm).toHaveBeenCalledWith('/p', 'eu-west-1'),
    ],
    [
      'ssm parameter with region resolving to empty',
      { aws_systems_manager_parameter: { name: '/p', region: '$empty' } },
      'aws_systems_manager_parameter:/p@$empty',
      'aws_systems_manager_parameter:/p@',
      () => expect(fetchSsm).toHaveBeenCalledWith('/p', undefined),
    ],
    [
      'ssm parameter without region',
      { aws_systems_manager_parameter: { name: '/p' } },
      'aws_systems_manager_parameter:/p',
      'aws_systems_manager_parameter:/p',
      () => expect(fetchSsm).toHaveBeenCalledWith('/p', undefined),
    ],
    [
      'vault with field',
      { vault: { path: 'secret/$v', field: 'f', sha: 'abc' } },
      'vault:secret/$v#f',
      'vault:secret/X#f',
      () => expect(fetchVault).toHaveBeenCalledWith('secret/X', 'f'),
    ],
    [
      'vault without field',
      { vault: { path: 'secret/p' } },
      'vault:secret/p',
      'vault:secret/p',
      () => expect(fetchVault).toHaveBeenCalledWith('secret/p', undefined),
    ],
    [
      'http object',
      { http: 'https://example.com/$v.txt', sha: 'abc' },
      'http:https://example.com/$v.txt',
      'http:https://example.com/X.txt',
      () => expect(fetchHttp).toHaveBeenCalledWith('https://example.com/X.txt'),
    ],
    [
      'url object (http)',
      { url: 'https://example.com/$v.txt', sha: 'abc' },
      'url:https://example.com/$v.txt',
      'url:https://example.com/X.txt',
      () =>
        expect(fetchHttp).toHaveBeenCalledWith(
          'https://example.com/X.txt',
          false,
        ),
    ],
  ])('%s', async (_desc, src, label, cacheKey, assertCall) => {
    const cache: FetchCache = new Map();
    const result = await fetchSource(entry(src), tmpDir, vars, cache);
    assertCall();
    expect(result.sourceRecords).toHaveLength(1);
    const [record] = result.sourceRecords;
    expect(record.sourceLabel).toBe(label);
    const expectedSha =
      typeof src === 'object' && 'sha' in src
        ? src.sha
        : (Object.values(src as object)[0] as { sha?: string }).sha;
    expect(record.expectedSha).toBe(expectedSha);
    expect(record.matched).toBe(expectedSha === undefined);
    expect([...cache.keys()]).toEqual([cacheKey]);
  });

  it('records the expected SHA for a path source', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'x');
    const result = await fetchSource(
      entry({ path: 'a.txt', sha: 'abc' }),
      tmpDir,
    );
    expect(result.sourceRecords[0]).toMatchObject({
      sourceLabel: 'path:a.txt',
      expectedSha: 'abc',
      matched: false,
    });
  });

  it('uses "download" as the filename when the URL has no basename', async () => {
    const result = await fetchSource(
      { src: { url: 'https://example.com/' }, target: 'dir/' },
      tmpDir,
    );
    expect([...result.files.keys()]).toEqual(['download']);
  });

  it('throws for an unknown source type', async () => {
    await expect(
      fetchSource(entry({ unknown: 1 } as unknown as FileSrc), tmpDir),
    ).rejects.toThrow('Unknown source type: {"unknown":1}');
  });

  it('builds a record for an unknown source type served from the cache', async () => {
    const src = { unknown: 1 } as unknown as FileSrc;
    const cache: FetchCache = new Map([
      [JSON.stringify(src), { files: ONE_FILE().files }],
    ]);
    const result = await fetchSource(entry(src), tmpDir, {}, cache);
    expect(result.sourceRecords[0]).toMatchObject({
      sourceLabel: '{"unknown":1}',
      expectedSha: undefined,
      matched: true,
    });
  });

  it('keys raw sources by their resolved content and records nothing', async () => {
    const cache: FetchCache = new Map();
    const result = await fetchSource(
      entry({ raw: 'hello $v' }),
      tmpDir,
      vars,
      cache,
    );
    expect([...cache.keys()]).toEqual(['raw:hello X']);
    expect(result.sourceRecords).toEqual([]);
    expect(result.files.get('output')?.toString()).toBe('hello X');
  });
});

// ── Plain-string github:/gitlab: specs ────────────────────────────────────────

describe('fetchSource — plain-string github:/gitlab: specs', () => {
  it('dispatches a github: string to fetchGitHub', async () => {
    await fetchSource(entry('github:o/r:a.txt@main'), tmpDir);
    expect(fetchGitHub).toHaveBeenCalledWith('o/r', 'a.txt', 'main');
  });

  it('throws a helpful error for an invalid github: string', async () => {
    await expect(fetchSource(entry('github:bad'), tmpDir)).rejects.toThrow(
      'Invalid github source spec "github:bad"',
    );
  });

  it('dispatches a gitlab: string to fetchGitLab', async () => {
    await fetchSource(entry('gitlab:g/p:a.txt'), tmpDir);
    expect(fetchGitLab).toHaveBeenCalledWith('g/p', 'a.txt', undefined);
  });

  it('throws a helpful error for an invalid gitlab: string', async () => {
    await expect(fetchSource(entry('gitlab:bad'), tmpDir)).rejects.toThrow(
      'Invalid gitlab source spec "gitlab:bad"',
    );
  });
});

// ── url: git remote failures ──────────────────────────────────────────────────

describe('fetchSource — url: git remote failures', () => {
  const url = 'git+ssh://git@host/repo.git//a.txt';

  it('skips an optional git remote source that fails to fetch', async () => {
    asMock(fetchGit).mockImplementation(() => {
      throw new Error('clone failed');
    });
    const result = await fetchSource(entry({ url, optional: true }), tmpDir);
    expect(result.allSkipped).toBe(true);
  });

  it('rethrows when a required git remote source fails to fetch', async () => {
    asMock(fetchGit).mockImplementation(() => {
      throw new Error('clone failed');
    });
    await expect(fetchSource(entry({ url }), tmpDir)).rejects.toThrow(
      'clone failed',
    );
  });
});

// ── Verbose logging ───────────────────────────────────────────────────────────

describe('fetchSource — verbose logging', () => {
  it('logs fetches and cache hits with redacted labels', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setVerbose(true);
    const cache: FetchCache = new Map();
    await fetchSource(entry({ raw: 'x' }), tmpDir, {}, cache);
    await fetchSource(entry({ raw: 'x' }), tmpDir, {}, cache);
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('fetching source: raw');
    expect(output).toContain('cache hit: raw');
  });
});

// ── Conditions ────────────────────────────────────────────────────────────────

describe('fetchSource — source-level conditions', () => {
  it('skips a source whose if condition is false', async () => {
    const result = await fetchSource(
      entry({ raw: 'x', if: { exists: 'does-not-exist' } }),
      tmpDir,
    );
    expect(result.allSkipped).toBe(true);
  });

  it('includes a source whose ifAny condition is true', async () => {
    writeFileSync(join(tmpDir, 'marker'), '');
    const result = await fetchSource(
      entry({ raw: 'x', ifAny: [{ exists: 'marker' }] }),
      tmpDir,
    );
    expect(result.files.get('output')?.toString()).toBe('x');
  });

  it('resolves the default target path for target_exists conditions', async () => {
    writeFileSync(join(tmpDir, 'out.txt'), 'existing');
    const result = await fetchSource(
      entry({ raw: 'x', if: { target_exists: true } }),
      tmpDir,
    );
    expect(result.files.get('output')?.toString()).toBe('x');
  });
});

// ── Pending writes ────────────────────────────────────────────────────────────

describe('fetchSource — pending writes path resolution', () => {
  it('resolves a relative plain-string path against the working directory', async () => {
    const pending = new Map([[resolve(tmpDir, 'rel.txt'), Buffer.from('p')]]);
    const result = await fetchSource(
      entry('rel.txt'),
      tmpDir,
      {},
      undefined,
      undefined,
      pending,
    );
    expect(result.files.get('rel.txt')?.toString()).toBe('p');
  });

  it('resolves a ~/ path against the home directory', async () => {
    const name = `avanti-pending-${process.pid}.txt`;
    const pending = new Map([[resolve(homedir(), name), Buffer.from('home')]]);
    const result = await fetchSource(
      entry({ path: `~/${name}` }),
      tmpDir,
      {},
      undefined,
      undefined,
      pending,
    );
    expect(result.files.get(name)?.toString()).toBe('home');
  });

  it('falls through to the regular fetch when resolving the path throws', async () => {
    await expect(
      fetchSource(
        entry('$undefinedVar'),
        tmpDir,
        {},
        undefined,
        undefined,
        new Map(),
      ),
    ).rejects.toThrow('Undefined variable');
  });
});

// ── Multi-source lists ────────────────────────────────────────────────────────

describe('fetchSource — multi-source lists', () => {
  it('rejects binary content in a multi-source merge', async () => {
    asMock(fetchExec).mockReturnValue(Buffer.from([0x61, 0x00, 0x62]));
    await expect(
      fetchSource(entry([{ raw: 'a' }, { exec: 'bin' }]), tmpDir),
    ).rejects.toThrow(
      '[source 1] Binary file "output" cannot be used in a multi-source merge (source 1)',
    );
  });

  it('wraps non-Error throws with the source index', async () => {
    asMock(fetchS3).mockRejectedValue('plain string failure');
    await expect(
      fetchSource(entry([{ aws_s3: 's3://b/k' }]), tmpDir),
    ).rejects.toThrow('[source 0] plain string failure');
  });

  it.each<[string, Partial<FileEntry>, string[], (out: string) => void]>([
    [
      'json',
      { json: true },
      ['{"a":1}', '{"b":2}'],
      (out) => expect(JSON.parse(out)).toEqual({ a: 1, b: 2 }),
    ],
    [
      'yaml',
      { yaml: true },
      ['a: 1', 'b: 2'],
      (out) => {
        expect(out).toContain('a: 1');
        expect(out).toContain('b: 2');
      },
    ],
    [
      'toml',
      { toml: true },
      ['a = 1', 'b = 2'],
      (out) => {
        expect(out).toContain('a = 1');
        expect(out).toContain('b = 2');
      },
    ],
    [
      'ini',
      { ini: true },
      ['[s]\na=1', '[s]\nb=2'],
      (out) => {
        expect(out).toContain('[s]');
        expect(out).toMatch(/a\s*=\s*1/);
        expect(out).toMatch(/b\s*=\s*2/);
      },
    ],
  ])('merges list sources as %s', async (_fmt, opts, parts, check) => {
    const result = await fetchSource(
      entry(
        parts.map((raw) => ({ raw })),
        opts,
      ),
      tmpDir,
    );
    check(result.files.get('out.txt')!.toString());
  });

  it('honours explicit format options and disables auto-detection when false', async () => {
    const result = await fetchSource(
      entry([{ raw: '{"a":1}' }], {
        json: { arrays: 'concat' } as FileEntry['json'],
      }),
      tmpDir,
    );
    expect(JSON.parse(result.files.get('out.txt')!.toString())).toEqual({
      a: 1,
    });
  });
});

// ── Extract ───────────────────────────────────────────────────────────────────

describe('fetchSource — extract', () => {
  beforeEach(() => {
    asMock(fetchHttp).mockResolvedValue(Buffer.from('archive bytes'));
    asMock(extractArchive).mockResolvedValue(
      filesOf({ 'bin/tool': 'tool', 'README.md': 'readme' }).files,
    );
  });

  const archive = 'https://example.com/tool.tar.gz';

  it('requires a single-file source', async () => {
    asMock(fetchGit).mockReturnValue(filesOf({ a: 'a', b: 'b' }));
    await expect(
      fetchSource(
        {
          src: { git: { repo: 'https://h/r.git', file: 'd/' } },
          target: 'out/',
          extract: true,
        },
        tmpDir,
      ),
    ).rejects.toThrow(
      '"extract" requires a single-file source, but source returned 2 file(s)',
    );
  });

  it('rejects a non-archive filename', async () => {
    await expect(
      fetchSource(
        { src: 'https://example.com/file.txt', target: 'out/', extract: true },
        tmpDir,
      ),
    ).rejects.toThrow(
      '"extract" was specified but "file.txt" is not a recognised archive format',
    );
  });

  it('returns all extracted files when extract is true', async () => {
    const result = await fetchSource(
      { src: archive, target: 'out/', extract: true },
      tmpDir,
    );
    expect([...result.files.keys()].sort()).toEqual(['README.md', 'bin/tool']);
    expect(extractArchive).toHaveBeenCalledWith(
      Buffer.from('archive bytes'),
      'tool.tar.gz',
    );
  });

  it('filters extracted files by resolved patterns', async () => {
    const result = await fetchSource(
      { src: archive, target: 'out/', extract: ['$dir/*'] },
      tmpDir,
      { dir: 'bin' },
    );
    expect([...result.files.keys()]).toEqual(['bin/tool']);
  });

  it.each<[string[], string]>([
    [['nope/*'], 'extract matched no entries (1 pattern: "nope/*")'],
    [
      ['nope/*', 'none/*'],
      'extract matched no entries (2 patterns: "nope/*", "none/*")',
    ],
  ])('reports when extract patterns %j match nothing', async (pats, msg) => {
    await expect(
      fetchSource({ src: archive, target: 'out/', extract: pats }, tmpDir),
    ).rejects.toThrow(msg);
  });

  it('rethrows other filter errors unchanged', async () => {
    await expect(
      fetchSource({ src: archive, target: 'out/', extract: ['/[/'] }, tmpDir),
    ).rejects.toThrow('pattern "/[/": invalid regex');
  });
});

// ── Directory source merged into a single-file target ─────────────────────────

describe('fetchSource — directory merges by contained extension', () => {
  function dirWith(files: Record<string, string>): string {
    const dir = join(tmpDir, 'src');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('merges a directory of TOML files', async () => {
    dirWith({ 'a.toml': 'a = 1', 'b.toml': 'b = 2' });
    const result = await fetchSource(
      { src: 'src', target: 'merged.toml.out' },
      tmpDir,
    );
    const out = result.files.get('merged.toml.out')!.toString();
    expect(out).toContain('a = 1');
    expect(out).toContain('b = 2');
  });

  it('merges a directory of INI files', async () => {
    dirWith({ 'a.ini': '[s]\na=1', 'b.cfg': '[s]\nb=2' });
    const result = await fetchSource(
      { src: 'src', target: 'merged.out' },
      tmpDir,
    );
    const out = result.files.get('merged.out')!.toString();
    expect(out).toMatch(/a\s*=\s*1/);
    expect(out).toMatch(/b\s*=\s*2/);
  });

  it('merges a directory of TOML files when toml is set explicitly', async () => {
    dirWith({ 'a.txt': 'a = 1', 'b.txt': 'b = 2' });
    const result = await fetchSource(
      { src: 'src', target: 'merged.out', toml: true },
      tmpDir,
    );
    expect(result.files.get('merged.out')!.toString()).toContain('b = 2');
  });
});

// ── Single-source formatting ──────────────────────────────────────────────────

describe('fetchSource — single-source formatting', () => {
  it.each<[string, Partial<FileEntry>]>([
    ['json', { json: true }],
    ['yaml', { yaml: true }],
    ['toml', { toml: true }],
    ['ini', { ini: true }],
  ])('rejects binary content when formatting as %s', async (fmt, opts) => {
    asMock(fetchExec).mockReturnValue(Buffer.from([0x00, 0x01]));
    await expect(
      fetchSource(entry({ exec: 'bin' }, opts), tmpDir),
    ).rejects.toThrow(
      `Binary file "output" cannot be formatted as ${fmt}. Remove the format option or use a text source.`,
    );
  });

  it('formats a single JSON source', async () => {
    const result = await fetchSource(
      entry({ raw: '{"a":1}' }, { json: true }),
      tmpDir,
    );
    expect(JSON.parse(result.files.get('output')!.toString())).toEqual({
      a: 1,
    });
  });

  it('formats a single TOML source', async () => {
    const result = await fetchSource(
      entry({ raw: 'a   =   1' }, { toml: true }),
      tmpDir,
    );
    expect(result.files.get('output')!.toString()).toContain('a = 1');
  });

  it('formats a single INI source', async () => {
    const result = await fetchSource(
      entry({ raw: '[s]\na=1' }, { ini: true }),
      tmpDir,
    );
    const out = result.files.get('output')!.toString();
    expect(out).toContain('[s]');
    expect(out).toMatch(/a\s*=\s*1/);
  });
});
