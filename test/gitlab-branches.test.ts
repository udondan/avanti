// Offline branch coverage for src/sources/gitlab.ts: every API / glab fallback
// path is exercised with a URL-routed fetch mock and an args-routed spawnSync
// mock (which also stands in for `tar`). No network access or GITLAB_TOKEN is
// needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fetchGitLab, fetchGitLabRelease } from '../src/sources/gitlab';
import { _testable } from '../src/fetch';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { MockInstance } from 'vitest';

const mockSpawnSync = spawnSync as unknown as MockInstance<
  (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; encoding?: string },
  ) => SpawnSyncReturns<string | Buffer>
>;

interface SpawnOut {
  stdout?: string | Buffer;
  stderr?: string;
  status?: number | null;
  error?: Error;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

type SpawnHandler = (args: string[], call: SpawnCall) => SpawnOut | undefined;

function makeSpawnResult(
  opts: SpawnOut,
  binary: boolean,
): SpawnSyncReturns<string | Buffer> {
  const stdout = opts.stdout ?? '';
  return {
    stdout: binary && typeof stdout === 'string' ? Buffer.from(stdout) : stdout,
    stderr: binary ? Buffer.from(opts.stderr ?? '') : (opts.stderr ?? ''),
    status: opts.status === undefined ? 0 : opts.status,
    pid: 0,
    output: [],
    signal: null,
    error: opts.error,
  };
}

/**
 * Routes glab and tar invocations. `glab --version` reports glab as available
 * unless `glabAvailable` is false; `tar` is delegated to `tar` (if given).
 * Unhandled invocations fail the test.
 */
function routeSpawn(
  glab: SpawnHandler,
  opts: {
    glabAvailable?: boolean;
    tar?: (extractDir: string) => SpawnOut;
  } = {},
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  mockSpawnSync.mockImplementation((cmd, args, options) => {
    const a = [...args];
    const call: SpawnCall = { cmd, args: a, env: options?.env };
    calls.push(call);
    const binary = options?.encoding === 'buffer';
    if (cmd === 'tar') {
      if (!opts.tar) throw new Error('unexpected tar call');
      return makeSpawnResult(opts.tar(a[a.indexOf('-C') + 1]), false);
    }
    if (a[0] === '--version') {
      return opts.glabAvailable === false
        ? makeSpawnResult({ error: new Error('ENOENT'), status: null }, false)
        : makeSpawnResult({ stdout: 'glab 1.0.0' }, false);
    }
    const out = glab(a, call);
    if (!out) throw new Error(`unexpected glab call: ${a.join(' ')}`);
    return makeSpawnResult(out, binary);
  });
  return calls;
}

/** Writes the given relative files below the tar extraction directory. */
function fakeTar(layout: Record<string, string>): (dir: string) => SpawnOut {
  return (dir) => {
    for (const [rel, content] of Object.entries(layout)) {
      const full = path.join(dir, rel);
      if (rel.endsWith('/')) {
        fs.mkdirSync(full, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return {};
  };
}

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function routeFetch(handler: FetchHandler) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => handler(urlOf(input), init));
}

function urlOf(input: string | URL | Request | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function status(code: number): Response {
  return new Response('', { status: code });
}

function networkError(): never {
  throw new TypeError('fetch failed');
}

function unexpected(what: string): never {
  throw new Error(`unexpected call: ${what}`);
}

function endpointOf(args: string[]): string {
  return args.find((a) => a.startsWith('projects/')) ?? '';
}

function keys(files: Map<string, Buffer>): string[] {
  return [...files.keys()].map((k) => k.replace(/\\/g, '/')).sort();
}

function names(list: string[]): Array<{ name: string }> {
  return list.map((name) => ({ name }));
}

function releases(list: string[]): Array<{ tag_name: string }> {
  return list.map((tag_name) => ({ tag_name }));
}

function filler(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `x-${i}`);
}

function headerOf(init: RequestInit | undefined, name: string) {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

const GL = 'https://gitlab.com/api/v4/projects/g%2Fp';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  delete process.env.GITLAB_HOST;
});

describe('gitlab — files', () => {
  it('fetches a file via API with the private token header', async () => {
    process.env.GITLAB_PRIVATE_TOKEN = 'ptok';
    const fetchSpy = routeFetch((url) => {
      if (url === `${GL}/repository/files/a%2Fb.txt?ref=main`) return json({});
      if (url === `${GL}/repository/files/a%2Fb.txt/raw?ref=main`)
        return new Response('content');
      return unexpected(url);
    });
    const result = await fetchGitLab('g/p', 'a/b.txt', 'main');
    expect(result.files.get('b.txt')?.toString()).toBe('content');
    expect(headerOf(fetchSpy.mock.calls[0][1], 'PRIVATE-TOKEN')).toBe('ptok');
  });

  it('defaults an empty ref to HEAD and honours GITLAB_HOST', async () => {
    process.env.GITLAB_HOST = 'gl.example.com';
    const fetchSpy = routeFetch(() => new Response('x'));
    await fetchGitLab('g/p', 'f.txt', '');
    expect(urlOf(fetchSpy.mock.calls[0][0])).toBe(
      'https://gl.example.com/api/v4/projects/g%2Fp/repository/files/f.txt?ref=HEAD',
    );
  });

  it('rejects an empty via array', async () => {
    await expect(
      fetchGitLab('g/p', 'f.txt', 'main', undefined, []),
    ).rejects.toThrow('via: array must not be empty');
  });

  it('falls back to glab when the path probe returns 404', async () => {
    routeFetch((url) =>
      url.includes('/raw?') ? new Response('api raw') : status(404),
    );
    routeSpawn(() => ({}));
    const result = await fetchGitLab('g/p', 'f.txt', 'main');
    expect(result.files.get('f.txt')?.toString()).toBe('api raw');
  });

  it('falls back to glab when the raw file returns 401', async () => {
    routeFetch((url) => (url.includes('/raw?') ? status(401) : json({})));
    routeSpawn(() => ({ stdout: 'glab raw' }));
    const result = await fetchGitLab('g/p', 'f.txt', 'main');
    expect(result.files.get('f.txt')?.toString()).toBe('glab raw');
  });

  it('throws when the raw file fails with a non-fallback status', async () => {
    routeFetch((url) => (url.includes('/raw?') ? status(422) : json({})));
    await expect(fetchGitLab('g/p', 'f.txt', 'main')).rejects.toThrow(
      'Failed to fetch f.txt from g/p@main: HTTP 422',
    );
  });

  it('throws on raw file 404 when glab is unavailable', async () => {
    routeFetch((url) => (url.includes('/raw?') ? status(404) : json({})));
    routeSpawn(() => undefined, { glabAvailable: false });
    await expect(fetchGitLab('g/p', 'f.txt', 'main')).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('rethrows a raw file network error with via: api', async () => {
    routeFetch((url) => (url.includes('/raw?') ? networkError() : json({})));
    await expect(
      fetchGitLab('g/p', 'f.txt', 'main', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('via: cli reports glab raw file failures', async () => {
    routeSpawn((args) =>
      args.some((a) => a.includes('/raw?'))
        ? { stderr: 'denied', status: 1 }
        : {},
    );
    await expect(
      fetchGitLab('g/p', 'f.txt', 'main', undefined, 'cli'),
    ).rejects.toThrow('Failed to fetch f.txt from g/p@main: denied');
  });

  it('via: [cli, api] falls back to the API when glab raw fetch fails', async () => {
    routeFetch(() => new Response('api'));
    routeSpawn((args) =>
      args.some((a) => a.includes('/raw?')) ? { status: 1 } : {},
    );
    const result = await fetchGitLab('g/p', 'f.txt', 'main', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('f.txt')?.toString()).toBe('api');
  });

  it('via: cli throws a glab spawn error from the path probe', async () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ error: new Error('spawn glab ENOENT') }, false),
    );
    await expect(
      fetchGitLab('g/p', 'f.txt', 'main', undefined, 'cli'),
    ).rejects.toThrow('glab error: spawn glab ENOENT');
  });

  it('via: [cli, api] falls back to the API when the glab path probe throws', async () => {
    routeFetch((url) =>
      url.includes('/raw?') ? new Response('api') : json({}),
    );
    routeSpawn(() => ({ stderr: 'nope', status: 1 }));
    const result = await fetchGitLab('g/p', 'f.txt', 'main', 'gl.example.com', [
      'cli',
      'api',
    ]);
    expect(result.files.get('f.txt')?.toString()).toBe('api');
  });

  it('wraps a glab spawn error from a binary fetch', async () => {
    routeFetch((url) => (url.includes('/raw?') ? status(403) : json({})));
    mockSpawnSync.mockImplementation((_cmd, args) =>
      args[0] === '--version'
        ? makeSpawnResult({}, false)
        : makeSpawnResult({ error: new Error('EPIPE') }, true),
    );
    await expect(fetchGitLab('g/p', 'f.txt', 'main')).rejects.toThrow(
      'glab error: EPIPE',
    );
  });
});

describe('gitlab — directories', () => {
  const archiveUrl = `${GL}/repository/archive.tar.gz?sha=main&path=dir`;

  it('extracts a directory from the archive (nested files)', async () => {
    routeFetch((url) => {
      if (url.includes('/repository/files/dir?')) return status(404);
      if (url === archiveUrl) return new Response('tgz-bytes');
      return unexpected(url);
    });
    routeSpawn(() => undefined, {
      glabAvailable: false,
      tar: fakeTar({
        'p-main/dir/a.txt': 'A',
        'p-main/dir/sub/b.txt': 'B',
        'p-main/other.txt': 'O',
      }),
    });
    const result = await fetchGitLab('g/p', 'dir', 'main');
    expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
    expect(result.files.get('a.txt')?.toString()).toBe('A');
  });

  function treeFallbackRoutes(archive: () => Response): FetchHandler {
    return (url) => {
      if (url.startsWith(`${GL}/repository/archive.tar.gz`)) return archive();
      if (url.includes('/repository/tree?')) {
        if (url.endsWith('&page=1'))
          return json([
            ...filler(99).map((p) => ({ type: 'tree', path: `dir/${p}` })),
            { type: 'blob', path: 'dir/a.txt' },
          ]);
        return json([{ type: 'blob', path: 'dir/sub/b.txt' }]);
      }
      if (url.includes('/repository/files/dir%2Fa.txt/raw'))
        return new Response('A');
      if (url.includes('/repository/files/dir%2Fsub%2Fb.txt/raw'))
        return new Response('B');
      return unexpected(url);
    };
  }

  const archiveFailures: Array<[string, (dir: string) => SpawnOut]> = [
    ['tar fails', () => ({ status: 2 })],
    ['the archive has several roots', fakeTar({ 'r1/x': '1', 'r2/y': '2' })],
    ['the directory is missing', fakeTar({ 'root/elsewhere/x': '1' })],
    ['the directory is empty', fakeTar({ 'root/dir/sub/': '' })],
  ];

  it.each(archiveFailures)(
    'falls back to the tree listing when %s',
    async (_name, tar) => {
      routeFetch(treeFallbackRoutes(() => new Response('tgz')));
      routeSpawn(() => undefined, { glabAvailable: false, tar });
      const result = await fetchGitLab('g/p', 'dir/', 'main');
      expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
    },
  );

  it('falls back to the tree listing for an empty archive body', async () => {
    routeFetch(treeFallbackRoutes(() => new Response('')));
    const result = await fetchGitLab('g/p', 'dir/', 'main');
    expect(result.files.size).toBe(2);
  });

  it('falls back to the tree listing when the archive returns 500', async () => {
    routeFetch(treeFallbackRoutes(() => status(500)));
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, 'api');
    expect(result.files.size).toBe(2);
  });

  it('falls back to the tree listing on an archive network error with via: api', async () => {
    routeFetch(treeFallbackRoutes(() => networkError()));
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, 'api');
    expect(result.files.size).toBe(2);
  });

  it('rethrows non-network archive errors', async () => {
    routeFetch(
      treeFallbackRoutes(() => {
        throw new TypeError('Invalid URL');
      }),
    );
    await expect(fetchGitLab('g/p', 'dir/', 'main')).rejects.toThrow(
      'Invalid URL',
    );
  });

  it('uses glab for the archive when the API returns 403', async () => {
    routeFetch((url) =>
      url.includes('archive') ? status(403) : unexpected(url),
    );
    routeSpawn(() => ({ stdout: 'tgz' }), {
      tar: fakeTar({ 'root/dir/a.txt': 'A' }),
    });
    const result = await fetchGitLab('g/p', 'dir/', 'main');
    expect(keys(result.files)).toEqual(['a.txt']);
  });

  it('throws when the tree listing is empty', async () => {
    routeFetch((url) => (url.includes('archive') ? status(422) : json([])));
    await expect(fetchGitLab('g/p', 'dir/', 'main')).rejects.toThrow(
      'Failed to fetch dir/ from g/p@main (not a file or empty directory)',
    );
  });

  it('falls back to glab when the tree API returns 404', async () => {
    routeFetch((url) => {
      if (url.includes('archive')) return status(422);
      if (url.includes('/repository/tree?')) return status(404);
      return new Response('api file');
    });
    routeSpawn((args) => {
      const ep = endpointOf(args);
      if (ep.includes('/repository/tree?'))
        return {
          stdout: JSON.stringify([{ type: 'blob', path: 'dir/a.txt' }]),
        };
      return undefined;
    });
    const result = await fetchGitLab('g/p', 'dir/', 'main');
    expect(result.files.get('a.txt')?.toString()).toBe('api file');
  });

  it('falls back to glab on a tree network error', async () => {
    routeFetch((url) => {
      if (url.includes('archive')) return status(422);
      if (url.includes('/repository/tree?')) return networkError();
      return new Response('api file');
    });
    routeSpawn((args) =>
      endpointOf(args).includes('/repository/tree?')
        ? { stdout: JSON.stringify([{ type: 'blob', path: 'dir/a.txt' }]) }
        : undefined,
    );
    const result = await fetchGitLab('g/p', 'dir/', 'main');
    expect(result.files.size).toBe(1);
  });

  it('rethrows a tree network error with via: api', async () => {
    routeFetch((url) => {
      if (url.includes('archive')) return status(422);
      return networkError();
    });
    await expect(
      fetchGitLab('g/p', 'dir/', 'main', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('throws non-fallback tree errors', async () => {
    routeFetch((url) => (url.includes('archive') ? status(422) : status(422)));
    await expect(fetchGitLab('g/p', 'dir/', 'main')).rejects.toThrow(
      'Failed to list tree dir in g/p@main: HTTP 422',
    );
  });

  it('via: cli paginates the glab tree listing after a failed archive', async () => {
    const calls = routeSpawn((args) => {
      const ep = endpointOf(args);
      if (ep.includes('archive')) return { stdout: '' };
      if (ep.includes('/repository/tree?') && ep.endsWith('&page=1'))
        return {
          stdout: JSON.stringify([
            ...filler(99).map((p) => ({ type: 'tree', path: p })),
            { type: 'blob', path: 'dir/a.txt' },
          ]),
        };
      if (ep.includes('/repository/tree?')) return { stdout: '[]' };
      if (ep.includes('/raw?')) return { stdout: 'cli file' };
      return undefined;
    });
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, 'cli');
    expect(result.files.get('a.txt')?.toString()).toBe('cli file');
    expect(
      calls.filter((c) => endpointOf(c.args).includes('tree?')),
    ).toHaveLength(2);
  });

  it('via: cli returns null from the archive on a glab spawn error', async () => {
    mockSpawnSync.mockImplementation((_cmd, args) => {
      const ep = endpointOf([...args]);
      if (ep.includes('archive'))
        return makeSpawnResult({ error: new Error('EPIPE') }, true);
      if (ep.includes('/repository/tree?'))
        return makeSpawnResult(
          { stdout: JSON.stringify([{ type: 'blob', path: 'dir/a.txt' }]) },
          false,
        );
      return makeSpawnResult({ stdout: 'x' }, true);
    });
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, 'cli');
    expect(result.files.size).toBe(1);
  });

  it('via: [cli, api] uses the API archive when glab yields none', async () => {
    routeFetch(() => new Response('tgz'));
    routeSpawn(() => ({ status: 1 }), {
      tar: fakeTar({ 'root/dir/a.txt': 'A' }),
    });
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('a.txt')?.toString()).toBe('A');
  });

  it('via: cli reports glab tree failures', async () => {
    routeSpawn((args) =>
      endpointOf(args).includes('archive')
        ? { status: 1 }
        : { stderr: 'tree denied', status: 1 },
    );
    await expect(
      fetchGitLab('g/p', 'dir/', 'main', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tree dir in g/p@main: tree denied');
  });

  it('via: [cli, api] falls back to the API tree when glab tree fails', async () => {
    routeFetch((url) => {
      if (url.includes('archive')) return status(422);
      if (url.includes('/repository/tree?'))
        return json([{ type: 'blob', path: 'dir/a.txt' }]);
      return new Response('api');
    });
    routeSpawn((args) =>
      endpointOf(args).includes('/raw?') ? { stdout: 'cli' } : { status: 1 },
    );
    const result = await fetchGitLab('g/p', 'dir/', 'main', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('a.txt')?.toString()).toBe('cli');
  });

  it('treats a non-fallback path probe status as a directory', async () => {
    routeFetch((url) => {
      if (url.includes('/repository/files/dir?')) return status(400);
      if (url.includes('archive')) return new Response('tgz');
      return unexpected(url);
    });
    routeSpawn(() => undefined, { tar: fakeTar({ 'root/dir/a.txt': 'A' }) });
    const result = await fetchGitLab('g/p', 'dir', 'main');
    expect(result.files.size).toBe(1);
  });
});

describe('gitlab — ref resolution via API', () => {
  const tagsUrl = `${GL}/repository/tags`;

  function fileRoutes(url: string): Response | undefined {
    if (url.includes('/repository/files/')) return new Response('file');
    return undefined;
  }

  it('$latest: paginates version-sorted tags for a semver match', async () => {
    const fetchSpy = routeFetch((url) => {
      if (url.startsWith(tagsUrl) && url.includes('order_by=version')) {
        return url.endsWith('&page=1')
          ? json(names(filler(100)))
          : json(names(['nightly', 'v2.1.0']));
      }
      return fileRoutes(url) ?? unexpected(url);
    });
    await fetchGitLab('g/p', 'f.txt', '$latest');
    expect(urlOf(fetchSpy.mock.calls.at(-1)?.[0])).toContain('ref=v2.1.0');
  });

  it('$latest: throws when no semver tags exist', async () => {
    routeFetch(() => json(names(['nightly'])));
    await expect(fetchGitLab('g/p', 'f.txt', '$latest')).rejects.toThrow(
      'No semver tags found for g/p (needed to resolve $latest)',
    );
  });

  it('$latest: falls back to glab on 403', async () => {
    const fetchSpy = routeFetch((url) => fileRoutes(url) ?? status(403));
    routeSpawn(() => ({ stdout: JSON.stringify(names(['v1.0.0'])) }));
    await fetchGitLab('g/p', 'f.txt', '$latest');
    expect(urlOf(fetchSpy.mock.calls.at(-1)?.[0])).toContain('ref=v1.0.0');
  });

  it('$latest: falls back to glab on a network error', async () => {
    routeFetch((url) =>
      url.startsWith(tagsUrl) ? networkError() : fileRoutes(url)!,
    );
    routeSpawn(() => ({ stdout: JSON.stringify(names(['v1.0.0'])) }));
    const result = await fetchGitLab('g/p', 'f.txt', '$latest');
    expect(result.files.size).toBe(1);
  });

  it('$latest: throws non-fallback errors', async () => {
    routeFetch(() => status(422));
    await expect(fetchGitLab('g/p', 'f.txt', '$latest')).rejects.toThrow(
      'Failed to list tags for g/p: HTTP 422',
    );
  });

  it('pattern: falls back to glab on a network error', async () => {
    routeFetch((url) =>
      url.startsWith(tagsUrl) ? networkError() : fileRoutes(url)!,
    );
    routeSpawn(() => ({ stdout: JSON.stringify(names(['v1.4.0'])) }));
    const result = await fetchGitLab('g/p', 'f.txt', '/^v1\\./');
    expect(result.files.size).toBe(1);
  });

  it('pattern: falls back to glab on 401', async () => {
    routeFetch((url) =>
      url.startsWith(tagsUrl) ? status(401) : fileRoutes(url)!,
    );
    routeSpawn(() => ({ stdout: JSON.stringify(names(['v1.4.0'])) }));
    const result = await fetchGitLab('g/p', 'f.txt', '/^v1\\./');
    expect(result.files.size).toBe(1);
  });

  it('pattern: throws on 401 when glab is unavailable', async () => {
    routeFetch(() => status(401));
    routeSpawn(() => undefined, { glabAvailable: false });
    await expect(fetchGitLab('g/p', 'f.txt', '/^v1\\./')).rejects.toThrow(
      'Failed to list tags for g/p: HTTP 401',
    );
  });

  it('$recent: falls back to glab on a network error', async () => {
    routeFetch((url) =>
      url.startsWith(tagsUrl) ? networkError() : fileRoutes(url)!,
    );
    routeSpawn(() => ({ stdout: JSON.stringify(names(['nightly'])) }));
    const result = await fetchGitLab('g/p', 'f.txt', '$recent');
    expect(result.files.size).toBe(1);
  });

  it('$recent: rethrows a network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitLab('g/p', 'f.txt', '$recent', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('$recent: falls back to glab on 404', async () => {
    routeFetch((url) =>
      url.startsWith(tagsUrl) ? status(404) : fileRoutes(url)!,
    );
    routeSpawn(() => ({ stdout: JSON.stringify(names(['nightly'])) }));
    const result = await fetchGitLab('g/p', 'f.txt', '$recent');
    expect(result.files.size).toBe(1);
  });

  it('$recent: throws non-fallback errors', async () => {
    routeFetch(() => status(422));
    await expect(fetchGitLab('g/p', 'f.txt', '$recent')).rejects.toThrow(
      'Failed to resolve $recent for g/p: HTTP 422',
    );
  });
});

describe('gitlab — ref resolution via glab', () => {
  function withFile(handler: SpawnHandler): SpawnHandler {
    return (args, call) =>
      endpointOf(args).includes('/repository/files/')
        ? { stdout: 'file' }
        : handler(args, call);
  }

  function refUsed(calls: SpawnCall[]): string | undefined {
    const ep = endpointOf(calls.at(-1)!.args);
    return /ref=([^&]+)/.exec(ep)?.[1];
  }

  it('pattern: paginates tags until a match', async () => {
    const calls = routeSpawn(
      withFile((args) =>
        endpointOf(args).endsWith('&page=1')
          ? { stdout: JSON.stringify(names(filler(100))) }
          : { stdout: JSON.stringify(names(['v1.2.3'])) },
      ),
    );
    await fetchGitLab('g/p', 'f.txt', '/^v1\\./', undefined, 'cli');
    expect(refUsed(calls)).toBe('v1.2.3');
  });

  it('pattern: throws when nothing matches', async () => {
    routeSpawn(() => ({ stdout: '' }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('No tags matching "/^v9/" found for g/p');
  });

  it('pattern: throws when a short page has no match', async () => {
    routeSpawn(() => ({ stdout: JSON.stringify(names(['v1.0.0'])) }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('No tags matching "/^v9/" found for g/p');
  });

  it('pattern: reports glab failures with and without stderr', async () => {
    routeSpawn(() => ({ stderr: 'bad\n', status: 1 }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tags for g/p: bad');
    routeSpawn(() => ({ status: 5 }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('glab exited with status 5');
  });

  it('$recent: returns the most recent tag', async () => {
    const calls = routeSpawn(
      withFile(() => ({ stdout: JSON.stringify(names(['nightly'])) })),
    );
    await fetchGitLab('g/p', 'f.txt', '$recent', undefined, 'cli');
    expect(refUsed(calls)).toBe('nightly');
  });

  it.each([
    ['empty output', { stdout: '' }],
    ['an empty list', { stdout: '[]' }],
  ])('$recent: throws for %s', async (_n, out) => {
    routeSpawn(() => out);
    await expect(
      fetchGitLab('g/p', 'f.txt', '$recent', undefined, 'cli'),
    ).rejects.toThrow('No tags found for g/p (needed to resolve $recent)');
  });

  it('$recent: reports glab failures', async () => {
    routeSpawn(() => ({ stderr: 'oops', status: 1 }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '$recent', undefined, 'cli'),
    ).rejects.toThrow('Failed to resolve $recent for g/p: oops');
  });

  it('$latest: throws when no semver tags exist', async () => {
    routeSpawn(() => ({ stdout: JSON.stringify(names(['nightly'])) }));
    await expect(
      fetchGitLab('g/p', 'f.txt', '$latest', undefined, 'cli'),
    ).rejects.toThrow(
      'No semver tags found for g/p (needed to resolve $latest)',
    );
  });

  it('via: [cli, api] falls back to the API when glab resolution fails', async () => {
    const fetchSpy = routeFetch((url) =>
      url.includes('/repository/tags')
        ? json(names(['api-tag']))
        : new Response('file'),
    );
    const calls = routeSpawn((args) =>
      endpointOf(args).includes('/repository/tags')
        ? { status: 1 }
        : { stdout: 'file' },
    );
    await fetchGitLab('g/p', 'f.txt', '$recent', undefined, ['cli', 'api']);
    expect(urlOf(fetchSpy.mock.calls.at(-1)?.[0])).toContain('/tags?');
    expect(calls.at(-1)?.args.join(' ')).toContain('ref=api-tag');
  });
});

describe('gitlab — release tag resolution via API', () => {
  const relList = `${GL}/releases?order_by=released_at`;
  const relLatest = `${GL}/releases/latest`;

  /** Release detail + asset download so the fetch completes after resolution. */
  function assetRoutes(url: string): Response | undefined {
    const m = /\/releases\/([^/?]+)$/.exec(url);
    if (m && m[1] !== 'latest')
      return json({
        assets: {
          links: [
            {
              name: `${decodeURIComponent(m[1])}.bin`,
              url: 'https://cdn.example.com/a.bin',
              link_type: 'other',
            },
          ],
        },
      });
    if (url === 'https://cdn.example.com/a.bin') return new Response('bin');
    return undefined;
  }

  async function resolvedTag(promise: Promise<{ files: Map<string, Buffer> }>) {
    const { files } = await promise;
    return [...files.keys()][0].replace(/\.bin$/, '');
  }

  it('pattern: paginates releases until a match', async () => {
    routeFetch((url) => {
      if (url.startsWith(relList))
        return url.endsWith('&page=1')
          ? json(releases(filler(100)))
          : json(releases(['v1.5.0']));
      return assetRoutes(url) ?? unexpected(url);
    });
    expect(await resolvedTag(fetchGitLabRelease('g/p', '/^v1\\./'))).toBe(
      'v1.5.0',
    );
  });

  it('$recent: falls back to the most recent tag when there are no releases', async () => {
    routeFetch((url) => {
      if (url.startsWith(relList)) return json([]);
      if (url.includes('/repository/tags')) return json(names(['nightly']));
      return assetRoutes(url) ?? unexpected(url);
    });
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$recent'))).toBe(
      'nightly',
    );
  });

  it('falls back to glab on a release listing network error', async () => {
    routeFetch((url) =>
      url.startsWith(relList)
        ? networkError()
        : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify(releases(['v3.0.0'])) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$recent'))).toBe(
      'v3.0.0',
    );
  });

  it('rethrows a release listing network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitLabRelease('g/p', '$recent', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('falls back to glab when the release listing returns 404', async () => {
    routeFetch((url) =>
      url.startsWith(relList)
        ? status(404)
        : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify(releases(['v3.0.0'])) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '/^v3/'))).toBe(
      'v3.0.0',
    );
  });

  it('resolves tags instead when the release listing returns 403 and glab is unavailable', async () => {
    routeFetch((url) => {
      if (url.startsWith(relList)) return status(403);
      if (url.includes('/repository/tags')) return json(names(['v3.1.0']));
      return assetRoutes(url) ?? unexpected(url);
    });
    routeSpawn(() => undefined, { glabAvailable: false });
    expect(await resolvedTag(fetchGitLabRelease('g/p', '/^v3/'))).toBe(
      'v3.1.0',
    );
  });

  it('falls back to glab when the release listing returns 401', async () => {
    routeFetch((url) =>
      url.startsWith(relList)
        ? status(401)
        : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify(releases(['v4.0.0'])) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$recent'))).toBe(
      'v4.0.0',
    );
  });

  it('throws non-fallback release listing errors', async () => {
    routeFetch(() => status(422));
    await expect(fetchGitLabRelease('g/p', '$recent')).rejects.toThrow(
      'Failed to resolve "$recent" release for g/p: HTTP 422',
    );
  });

  it('$latest: falls back to glab on a network error', async () => {
    routeFetch((url) =>
      url === relLatest
        ? networkError()
        : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify({ tag_name: 'v5.0.0' }) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$latest'))).toBe(
      'v5.0.0',
    );
  });

  it('$latest: rethrows a network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitLabRelease('g/p', '$latest', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('$latest: scans semver tags when the latest release is not semver', async () => {
    routeFetch((url) => {
      if (url === relLatest) return json({ tag_name: 'nightly' });
      if (url.includes('/repository/tags')) return json(names(['v1.1.0']));
      return assetRoutes(url) ?? unexpected(url);
    });
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$latest'))).toBe(
      'v1.1.0',
    );
  });

  it('$latest: falls back to glab on 401', async () => {
    routeFetch((url) =>
      url === relLatest ? status(401) : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify({ tag_name: 'v6.0.0' }) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$latest'))).toBe(
      'v6.0.0',
    );
  });

  it('$latest: throws non-fallback errors', async () => {
    routeFetch(() => status(422));
    await expect(fetchGitLabRelease('g/p', '$latest')).rejects.toThrow(
      'Failed to resolve $latest release for g/p: HTTP 422',
    );
  });

  it('$latest: falls back to glab on 404', async () => {
    routeFetch((url) =>
      url === relLatest ? status(404) : (assetRoutes(url) ?? unexpected(url)),
    );
    routeSpawn(() => ({ stdout: JSON.stringify({ tag_name: 'v7.0.0' }) }));
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$latest'))).toBe(
      'v7.0.0',
    );
  });

  it('$latest: scans tags on 403 when glab is unavailable', async () => {
    routeFetch((url) => {
      if (url === relLatest) return status(403);
      if (url.includes('/repository/tags')) return json(names(['v8.0.0']));
      return assetRoutes(url) ?? unexpected(url);
    });
    routeSpawn(() => undefined, { glabAvailable: false });
    expect(await resolvedTag(fetchGitLabRelease('g/p', '$latest'))).toBe(
      'v8.0.0',
    );
  });
});

describe('gitlab — release tag resolution via glab', () => {
  /** Answers release detail lookups so fetchReleaseLinksViaCli can finish. */
  function withAssets(handler: SpawnHandler): SpawnHandler {
    return (args, call) => {
      const ep = endpointOf(args);
      const m = /\/releases\/([^/?]+)$/.exec(ep);
      if (m && m[1] !== 'latest') {
        return {
          stdout: JSON.stringify({
            assets: {
              links: [
                {
                  name: `${decodeURIComponent(m[1])}.bin`,
                  url: 'https://cdn.example.com/a.bin',
                  link_type: 'other',
                },
              ],
            },
          }),
        };
      }
      return handler(args, call);
    };
  }

  async function resolvedTag(promise: Promise<{ files: Map<string, Buffer> }>) {
    const { files } = await promise;
    return [...files.keys()][0].replace(/\.bin$/, '');
  }

  beforeEach(() => {
    process.env.GITLAB_TOKEN = 'tok';
    routeFetch(() => new Response('bin'));
  });

  it('pattern: paginates releases until a match', async () => {
    routeSpawn(
      withAssets((args) =>
        endpointOf(args).endsWith('&page=1')
          ? { stdout: JSON.stringify(releases(filler(100))) }
          : { stdout: JSON.stringify(releases(['v2.2.0'])) },
      ),
    );
    expect(
      await resolvedTag(fetchGitLabRelease('g/p', '/^v2/', undefined, 'cli')),
    ).toBe('v2.2.0');
  });

  it.each([
    ['empty output', ''],
    ['a short page without a match', JSON.stringify(releases(['v1.0.0']))],
    ['invalid JSON', 'not json'],
  ])('pattern: throws for %s', async (_n, stdout) => {
    routeSpawn(() => ({ stdout }));
    await expect(
      fetchGitLabRelease('g/p', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('No releases matching "/^v9/" found for g/p');
  });

  it('pattern: treats a non-array payload like no releases', async () => {
    routeSpawn(() => ({ stdout: '{}' }));
    await expect(
      fetchGitLabRelease('g/p', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('No releases matching "/^v9/" found for g/p');
  });

  it('reports glab release listing failures', async () => {
    routeSpawn(() => ({ stderr: 'nope', status: 1 }));
    await expect(
      fetchGitLabRelease('g/p', '/^v9/', undefined, 'cli'),
    ).rejects.toThrow('Failed to list releases for g/p: nope');
    routeSpawn(() => ({ status: 6 }));
    await expect(
      fetchGitLabRelease('g/p', '$recent', undefined, 'cli'),
    ).rejects.toThrow('glab exited with status 6');
  });

  it('$recent: returns the most recent release', async () => {
    routeSpawn(
      withAssets(() => ({ stdout: JSON.stringify(releases(['r1', 'r0'])) })),
    );
    expect(
      await resolvedTag(fetchGitLabRelease('g/p', '$recent', undefined, 'cli')),
    ).toBe('r1');
  });

  it('$recent: falls back to the most recent tag without releases', async () => {
    routeSpawn(
      withAssets((args) =>
        endpointOf(args).includes('/releases?')
          ? { stdout: '[]' }
          : { stdout: JSON.stringify(names(['t1'])) },
      ),
    );
    expect(
      await resolvedTag(fetchGitLabRelease('g/p', '$recent', undefined, 'cli')),
    ).toBe('t1');
  });

  it.each([
    ['glab fails', { stderr: 'tags denied', status: 1 }, /tags denied/],
    ['output is empty', { stdout: '' }, /No releases or tags found/],
    ['the list is empty', { stdout: '[]' }, /No releases or tags found/],
  ])('$recent: throws when the tag fallback %s', async (_n, tagOut, err) => {
    routeSpawn((args) =>
      endpointOf(args).includes('/releases?') ? { stdout: '' } : tagOut,
    );
    await expect(
      fetchGitLabRelease('g/p', '$recent', undefined, 'cli'),
    ).rejects.toThrow(err);
  });

  it('$latest: returns a semver latest release', async () => {
    routeSpawn(
      withAssets(() => ({ stdout: JSON.stringify({ tag_name: 'v9.9.9' }) })),
    );
    expect(
      await resolvedTag(fetchGitLabRelease('g/p', '$latest', undefined, 'cli')),
    ).toBe('v9.9.9');
  });

  it.each([
    ['is not semver', { stdout: JSON.stringify({ tag_name: 'nightly' }) }],
    ['has no tag', { stdout: '{}' }],
    ['is invalid JSON', { stdout: '<html>' }],
    ['fails', { status: 1 }],
  ])('$latest: scans tags when the latest release %s', async (_n, relOut) => {
    routeSpawn(
      withAssets((args) =>
        endpointOf(args).endsWith('/releases/latest')
          ? relOut
          : { stdout: JSON.stringify(names(['v0.0.1'])) },
      ),
    );
    expect(
      await resolvedTag(fetchGitLabRelease('g/p', '$latest', undefined, 'cli')),
    ).toBe('v0.0.1');
  });

  it.each([
    ['glab fails', { stderr: 'tags denied', status: 1 }, /tags denied/],
    ['output is empty', { stdout: '' }, /No releases or tags found/],
    ['the list is empty', { stdout: '[]' }, /No releases or tags found/],
  ])('$latest: throws when the tag scan %s', async (_n, tagOut, err) => {
    routeSpawn((args) =>
      endpointOf(args).endsWith('/releases/latest') ? { status: 1 } : tagOut,
    );
    await expect(
      fetchGitLabRelease('g/p', '$latest', undefined, 'cli'),
    ).rejects.toThrow(err);
  });

  it('via: [cli, api] falls back to the API when glab resolution fails', async () => {
    routeFetch((url) => {
      if (url.includes('/releases?')) return json(releases(['api-rel']));
      if (url.endsWith('/releases/api-rel'))
        return json({
          assets: {
            links: [
              {
                name: 'api-rel.bin',
                url: 'https://cdn.example.com/a.bin',
                link_type: 'other',
              },
            ],
          },
        });
      return new Response('bin');
    });
    routeSpawn(() => ({ status: 1 }));
    expect(
      await resolvedTag(
        fetchGitLabRelease('g/p', '$recent', undefined, ['cli', 'api']),
      ),
    ).toBe('api-rel');
  });
});

describe('gitlab — release downloads via API', () => {
  const relUrl = `${GL}/releases/v1.0.0`;

  function link(
    name: string,
    url: string,
    extra: Partial<{ direct_asset_url: string; link_type: string }> = {},
  ) {
    return { name, url, link_type: 'package', ...extra };
  }

  it('applies the pre-filter', async () => {
    const fetchSpy = routeFetch((url) =>
      url === relUrl
        ? json({
            assets: {
              links: [
                link('a.zip', 'https://cdn.example.com/a.zip'),
                link('b.tgz', 'https://cdn.example.com/b.tgz'),
              ],
            },
          })
        : new Response(url),
    );
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api', [
      '*.zip',
    ]);
    expect([...result.files.keys()]).toEqual(['a.zip']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns an empty map when the pre-filter matches nothing', async () => {
    routeFetch(() =>
      json({ assets: { links: [link('a.zip', 'https://x.example/a.zip')] } }),
    );
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api', [
      '*.exe',
    ]);
    expect(result.files.size).toBe(0);
  });

  it('rewrites upload URLs and retries direct_asset_url on 404', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    const fetchSpy = routeFetch((url) => {
      if (url === relUrl)
        return json({
          assets: {
            links: [
              link('a.zip', 'https://gitlab.com/-/project/7/uploads/h/a.zip', {
                direct_asset_url: 'https://gitlab.com/g/p/-/releases/v1/a.zip',
              }),
            ],
          },
        });
      if (url === 'https://gitlab.com/api/v4/projects/7/uploads/h/a.zip')
        return status(404);
      if (url === 'https://gitlab.com/g/p/-/releases/v1/a.zip')
        return new Response('direct');
      return unexpected(url);
    });
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api');
    expect(result.files.get('a.zip')?.toString()).toBe('direct');
    const last = fetchSpy.mock.calls.at(-1)!;
    expect(headerOf(last[1], 'PRIVATE-TOKEN')).toBe('tok');
  });

  it('retries an external direct_asset_url without the token', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    const fetchSpy = routeFetch((url) => {
      if (url === relUrl)
        return json({
          assets: {
            links: [
              link('a.zip', 'https://gitlab.com/-/project/7/uploads/h/a.zip', {
                direct_asset_url: 'https://s3.example.com/a.zip',
              }),
            ],
          },
        });
      if (url.includes('/api/v4/projects/7/uploads/')) return status(404);
      return new Response('s3');
    });
    await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api');
    expect(headerOf(fetchSpy.mock.calls.at(-1)![1], 'PRIVATE-TOKEN')).toBe(
      undefined,
    );
  });

  it('throws when the upload 404s and there is no other URL', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    routeFetch((url) =>
      url === relUrl
        ? json({
            assets: {
              links: [
                link(
                  'a.zip',
                  'https://gitlab.com/api/v4/projects/7/uploads/h/a.zip',
                  {
                    direct_asset_url:
                      'https://gitlab.com/api/v4/projects/7/uploads/h/a.zip',
                  },
                ),
                link(
                  'b.zip',
                  'https://gitlab.com/-/project/7/uploads/h/b.zip',
                  {
                    direct_asset_url:
                      'https://gitlab.com/api/v4/projects/7/uploads/h/b.zip',
                  },
                ),
              ],
            },
          })
        : status(404),
    );
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api'),
    ).rejects.toThrow(
      /Failed to download release asset "(a|b)\.zip" from g\/p@v1\.0\.0: HTTP 404/,
    );
  });

  it('follows redirects, dropping the token off-host', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    const seen: Array<[string, string | undefined]> = [];
    routeFetch((url, init) => {
      seen.push([url, headerOf(init, 'PRIVATE-TOKEN')]);
      if (url === relUrl)
        return json({
          assets: { links: [link('a.zip', 'https://gitlab.com/files/a.zip')] },
        });
      if (url === 'https://gitlab.com/files/a.zip')
        return new Response(null, {
          status: 302,
          headers: { location: '/files/moved.zip' },
        });
      if (url === 'https://gitlab.com/files/moved.zip')
        return new Response(null, {
          status: 307,
          headers: { location: 'https://s3.example.com/a.zip' },
        });
      if (url === 'https://s3.example.com/a.zip') return new Response('final');
      return unexpected(url);
    });
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api');
    expect(result.files.get('a.zip')?.toString()).toBe('final');
    expect(seen.slice(1)).toEqual([
      ['https://gitlab.com/files/a.zip', 'tok'],
      ['https://gitlab.com/files/moved.zip', 'tok'],
      ['https://s3.example.com/a.zip', undefined],
    ]);
  });

  it('treats a redirect without location as the final response', async () => {
    routeFetch((url) =>
      url === relUrl
        ? json({ assets: { links: [link('a.zip', 'https://x.example/a')] } })
        : new Response(null, { status: 304 }),
    );
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api'),
    ).rejects.toThrow('HTTP 304');
  });

  it('gives up after too many redirects', async () => {
    routeFetch((url) =>
      url === relUrl
        ? json({ assets: { links: [link('a.zip', 'https://x.example/a')] } })
        : new Response(null, {
            status: 301,
            headers: { location: 'https://x.example/a' },
          }),
    );
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'api'),
    ).rejects.toThrow('Too many redirects fetching https://x.example/a');
  });

  it('throws non-fallback release errors', async () => {
    routeFetch(() => status(422));
    await expect(fetchGitLabRelease('g/p', 'v1.0.0')).rejects.toThrow(
      'Failed to fetch release v1.0.0 from g/p: HTTP 422',
    );
  });

  it('throws on 404 when glab is unavailable', async () => {
    routeFetch(() => status(404));
    routeSpawn(() => undefined, { glabAvailable: false });
    await expect(fetchGitLabRelease('g/p', 'v1.0.0')).rejects.toThrow(
      'HTTP 404',
    );
  });
});

describe('gitlab — release downloads via glab', () => {
  function meta(links: unknown[] | undefined): SpawnOut {
    return {
      stdout: JSON.stringify(links === undefined ? {} : { assets: { links } }),
    };
  }

  function lnk(
    name: string,
    url: string,
    extra: Partial<{ direct_asset_url: string; link_type: string }> = {},
  ) {
    return { name, url, link_type: 'package', ...extra };
  }

  function dlDir(args: string[]): string {
    return args[args.indexOf('-D') + 1];
  }

  it('reports glab metadata failures', async () => {
    routeSpawn(() => ({ stderr: 'meta denied', status: 1 }));
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('Failed to fetch release v1.0.0 from g/p: meta denied');
  });

  it('throws when the release has no links', async () => {
    routeSpawn(() => meta(undefined));
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('No release assets found for g/p@v1.0.0');
  });

  it('applies the pre-filter and returns an empty map when nothing matches', async () => {
    routeSpawn(() => meta([lnk('a.zip', 'https://gitlab.com/a.zip')]));
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli', [
      '*.exe',
    ]);
    expect(result.files.size).toBe(0);
  });

  it('downloads only filtered links with a token', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    const fetchSpy = routeFetch((url) => new Response(url));
    routeSpawn(() =>
      meta([
        lnk('a.zip', 'https://gitlab.com/a.zip', { link_type: 'other' }),
        lnk('b.tgz', 'https://gitlab.com/b.tgz', { link_type: 'other' }),
      ]),
    );
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli', [
      '*.tgz',
    ]);
    expect([...result.files.keys()]).toEqual(['b.tgz']);
    expect(headerOf(fetchSpy.mock.calls[0][1], 'PRIVATE-TOKEN')).toBe('tok');
  });

  it('retries direct_asset_url after an upload 404, scoping the token', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    const seen: Array<[string, string | undefined]> = [];
    routeFetch((url, init) => {
      seen.push([url, headerOf(init, 'PRIVATE-TOKEN')]);
      if (url.includes('/api/v4/projects/1/uploads/')) return status(404);
      return new Response('ok');
    });
    routeSpawn(() =>
      meta([
        lnk('a.zip', 'https://gitlab.com/-/project/1/uploads/h/a.zip', {
          direct_asset_url: 'https://gitlab.com/g/p/-/releases/v1/a.zip',
        }),
        lnk('b.zip', 'https://gitlab.com/-/project/1/uploads/h/b.zip', {
          direct_asset_url: 'https://s3.example.com/b.zip',
        }),
      ]),
    );
    const result = await fetchGitLabRelease(
      'g/p',
      'v1.0.0',
      'gitlab.com',
      'cli',
    );
    expect(result.files.size).toBe(2);
    expect(seen).toEqual([
      ['https://gitlab.com/api/v4/projects/1/uploads/h/a.zip', 'tok'],
      ['https://gitlab.com/g/p/-/releases/v1/a.zip', 'tok'],
      ['https://gitlab.com/api/v4/projects/1/uploads/h/b.zip', 'tok'],
      ['https://s3.example.com/b.zip', undefined],
    ]);
  });

  it('does not retry when the fallback equals the failed URL', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    routeFetch(() => status(404));
    routeSpawn(() =>
      meta([
        lnk('a.zip', 'https://gitlab.com/-/project/1/uploads/h/a.zip', {
          direct_asset_url:
            'https://gitlab.com/api/v4/projects/1/uploads/h/a.zip',
        }),
      ]),
    );
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow(
      'Failed to download release asset "a.zip" from g/p@v1.0.0: HTTP 404',
    );
  });

  it('resolves the token from glab auth status and infers the host', async () => {
    const fetchSpy = routeFetch(() => new Response('ok'));
    const calls = routeSpawn((args) => {
      if (args[0] === 'auth') {
        if (args.includes('--hostname'))
          return { stderr: 'not logged in', status: 1 };
        return {
          stderr: [
            'gitlab.com',
            '  ✓ Token found: wrong-token',
            'gl.example.com (env)',
            '  ✓ Logged in',
            '',
            '  ✓ Token found: right-token',
          ].join('\n'),
          status: 1,
        };
      }
      return meta([
        lnk('a.zip', 'https://gl.example.com/a.zip', {
          direct_asset_url: 'https://gl.example.com/d/a.zip',
        }),
      ]);
    });
    process.env.GITLAB_HOST = 'gl.example.com';
    await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli');
    expect(headerOf(fetchSpy.mock.calls[0][1], 'PRIVATE-TOKEN')).toBe(
      'right-token',
    );
    const fallback = calls.find((c) => c.args.includes('--all'));
    expect(fallback?.env?.GITLAB_HOST).toBeUndefined();
  });

  it('matches an ssh.-prefixed host section', async () => {
    const fetchSpy = routeFetch(() => new Response('ok'));
    routeSpawn((args) => {
      if (args[0] === 'auth') {
        if (args.includes('--hostname')) return { status: 1 };
        return { stdout: 'ssh.gl.example.com\n  Token found: ssh-token\n' };
      }
      return meta([lnk('a.zip', 'https://gl.example.com/a.zip')]);
    });
    await fetchGitLabRelease('g/p', 'v1.0.0', 'gl.example.com', 'cli');
    expect(headerOf(fetchSpy.mock.calls[0][1], 'PRIVATE-TOKEN')).toBe(
      'ssh-token',
    );
  });

  it('uses the scoped glab auth token when glab exits 0', async () => {
    const fetchSpy = routeFetch(() => new Response('ok'));
    routeSpawn((args) => {
      if (args[0] === 'auth') return { stdout: 'Token found: scoped' };
      return meta([lnk('a.zip', 'https://gl.example.com/a.zip')]);
    });
    await fetchGitLabRelease('g/p', 'v1.0.0', 'gl.example.com', 'cli');
    expect(headerOf(fetchSpy.mock.calls[0][1], 'PRIVATE-TOKEN')).toBe('scoped');
  });

  it('downloads with glab release download when no token is available', async () => {
    routeFetch((url) => unexpected(url));
    routeSpawn((args) => {
      if (args[0] === 'auth') return { status: 1 };
      if (args[0] === 'release') {
        const dir = dlDir(args);
        fs.writeFileSync(path.join(dir, 'a.zip'), 'glab-a');
        return {};
      }
      return meta([
        lnk('a.zip', 'https://gitlab.com/a.zip'),
        lnk('missing.zip', 'https://gitlab.com/missing.zip'),
      ]);
    });
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli');
    expect([...result.files.keys()]).toEqual(['a.zip']);
    expect(result.files.get('a.zip')?.toString()).toBe('glab-a');
  });

  it('throws when glab release download downloads nothing', async () => {
    routeSpawn((args) => {
      if (args[0] === 'auth') return { status: 1 };
      if (args[0] === 'release') return {};
      return meta([lnk('a.zip', 'https://gitlab.com/a.zip')]);
    });
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('No release assets found for g/p@v1.0.0');
  });

  it('reports glab release download failures', async () => {
    routeSpawn((args) => {
      if (args[0] === 'auth') return { status: 1 };
      if (args[0] === 'release') return { stderr: 'dl failed', status: 3 };
      return meta([lnk('a.zip', 'https://gitlab.com/a.zip')]);
    });
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('glab release download failed (exit 3): dl failed');
  });

  it('reports glab release download spawn errors', async () => {
    routeSpawn((args) => {
      if (args[0] === 'auth') return { status: 1 };
      if (args[0] === 'release') return { error: new Error('ENOENT') };
      return meta([lnk('a.zip', 'https://gitlab.com/a.zip')]);
    });
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('glab error: ENOENT');
  });

  it('throws when a token download fails', async () => {
    process.env.GITLAB_TOKEN = 'tok';
    routeFetch(() => status(410));
    routeSpawn(() => meta([lnk('a.zip', 'https://gitlab.com/a.zip')]));
    await expect(
      fetchGitLabRelease('g/p', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('HTTP 410');
  });

  it('via: [cli, api] falls back to the API when glab fails', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/v1.0.0')
        ? json({
            assets: { links: [lnk('a.zip', 'https://cdn.example.com/a.zip')] },
          })
        : new Response('api'),
    );
    routeSpawn(() => ({ status: 1 }));
    const result = await fetchGitLabRelease('g/p', 'v1.0.0', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('a.zip')?.toString()).toBe('api');
  });
});
