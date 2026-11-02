// Offline branch coverage for src/sources/github.ts: every API / gh fallback
// path is exercised with a URL-routed fetch mock and an args-routed spawnSync
// mock. No network access or GITHUB_TOKEN is needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fetchGitHub, fetchGitHubRelease } from '../src/sources/github';
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
    options: object,
  ) => SpawnSyncReturns<string>
>;

interface SpawnOut {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: Error;
}

function makeSpawnResult(opts: SpawnOut): SpawnSyncReturns<string> {
  return {
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    status: opts.status === undefined ? 0 : opts.status,
    pid: 0,
    output: [],
    signal: null,
    error: opts.error,
  };
}

/**
 * Routes gh invocations to a handler. `gh --version` reports gh as available
 * unless `ghAvailable` is false. Unhandled invocations fail the test.
 */
function routeGh(
  handler: (args: string[]) => SpawnOut | undefined,
  ghAvailable = true,
): string[][] {
  const calls: string[][] = [];
  mockSpawnSync.mockImplementation((_cmd, args) => {
    const a = [...args];
    calls.push(a);
    if (a[0] === '--version') {
      return ghAvailable
        ? makeSpawnResult({ stdout: 'gh version 2.0.0' })
        : makeSpawnResult({ error: new Error('ENOENT'), status: null });
    }
    const out = handler(a);
    if (!out) throw new Error(`unexpected gh call: ${a.join(' ')}`);
    return makeSpawnResult(out);
  });
  return calls;
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function networkError(): never {
  throw new TypeError('fetch failed');
}

function unexpected(url: string): never {
  throw new Error(`unexpected fetch: ${url}`);
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function fileJson(content: string): Response {
  return json({ type: 'file', content: b64(content) });
}

function keys(files: Map<string, Buffer>): string[] {
  return [...files.keys()].map((k) => k.replace(/\\/g, '/')).sort();
}

function tagPage(names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

function filler(n: number, prefix = 'x'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_HOST;
});

describe('github — request setup', () => {
  it('uses the GitHub Enterprise API base and token header', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    const fetchSpy = routeFetch(() => fileJson('ghe'));

    const result = await fetchGitHub(
      'o/r',
      'a b/f.txt',
      'main',
      ' ghe.example.com ',
    );
    expect(result.files.get('f.txt')?.toString()).toBe('ghe');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(urlOf(url)).toBe(
      'https://ghe.example.com/api/v3/repos/o/r/contents/a%20b/f.txt?ref=main',
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('uses GITHUB_HOST and defaults the ref to HEAD', async () => {
    process.env.GITHUB_HOST = 'env.example.com';
    const fetchSpy = routeFetch(() => fileJson('env'));

    await fetchGitHub('o/r', 'f.txt', undefined);
    expect(urlOf(fetchSpy.mock.calls[0][0])).toBe(
      'https://env.example.com/api/v3/repos/o/r/contents/f.txt?ref=HEAD',
    );
  });

  it('passes --hostname to gh for an explicit host', async () => {
    routeFetch(() => unexpected('none'));
    const calls = routeGh(() => ({ stdout: b64('cli') }));

    await fetchGitHub('o/r', 'f.txt', 'main', 'ghe.example.com', 'cli');
    expect(calls[0].slice(0, 3)).toEqual([
      'api',
      '--hostname',
      'ghe.example.com',
    ]);
  });

  it('rejects an empty via array', async () => {
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, []),
    ).rejects.toThrow('via: array must not be empty');
  });

  it('wraps a gh spawn error', async () => {
    mockSpawnSync.mockReturnValue(
      makeSpawnResult({ error: new Error('spawn gh ENOENT'), status: null }),
    );
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'cli'),
    ).rejects.toThrow('gh error: spawn gh ENOENT');
  });

  it('treats null gh stdout and stderr as empty strings', async () => {
    mockSpawnSync.mockReturnValue({
      ...makeSpawnResult({ status: 1 }),
      stdout: null,
      stderr: null,
    } as unknown as SpawnSyncReturns<string>);
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'cli'),
    ).rejects.toThrow(/^Failed to fetch f\.txt from o\/r@main: $/);
  });
});

describe('github — error details', () => {
  it('appends the JSON message to HTTP errors', async () => {
    routeFetch(() => json({ message: 'Bad credentials' }, 400));
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'api'),
    ).rejects.toThrow(
      'Failed to fetch f.txt from o/r@main: HTTP 400: Bad credentials',
    );
  });

  it('omits detail for JSON without a message', async () => {
    routeFetch(() => json({ message: '' }, 400));
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'api'),
    ).rejects.toThrow(/HTTP 400$/);
  });

  it('omits detail for unparsable JSON', async () => {
    routeFetch(
      () =>
        new Response('not json', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'api'),
    ).rejects.toThrow(/HTTP 400$/);
  });

  it('omits detail for non-JSON bodies', async () => {
    routeFetch(() => new Response('oops', { status: 400 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'api'),
    ).rejects.toThrow(/HTTP 400$/);
  });
});

describe('github — file fetch fallbacks', () => {
  it('falls back to gh when the contents API returns 404', async () => {
    routeFetch(() => new Response('nf', { status: 404 }));
    routeGh(() => ({ stdout: b64('from gh') }));

    const result = await fetchGitHub('o/r', 'f.txt', 'main');
    expect(result.files.get('f.txt')?.toString()).toBe('from gh');
  });

  it('throws the HTTP error on 404 when gh is unavailable', async () => {
    routeFetch(() => new Response('nf', { status: 404 }));
    routeGh(() => undefined, false);

    await expect(fetchGitHub('o/r', 'f.txt', 'main')).rejects.toThrow(
      'Failed to fetch f.txt from o/r@main: HTTP 404',
    );
  });

  it('via: cli throws when gh fails', async () => {
    routeGh(() => ({ stderr: 'boom', status: 1 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', 'main', undefined, 'cli'),
    ).rejects.toThrow('Failed to fetch f.txt from o/r@main: boom');
  });

  it('decodes gh output with escaped newlines', async () => {
    const encoded = b64('multi line content here');
    routeGh(() => ({
      stdout: `${encoded.slice(0, 8)}\\n${encoded.slice(8)}\n`,
    }));
    const result = await fetchGitHub('o/r', 'f.txt', 'main', undefined, 'cli');
    expect(result.files.get('f.txt')?.toString()).toBe(
      'multi line content here',
    );
  });
});

describe('github — directories via API', () => {
  const tree = {
    truncated: false,
    tree: [
      { type: 'tree', path: 'dir/sub' },
      { type: 'blob', path: 'dir/a.txt' },
      { type: 'blob', path: 'dir/sub/b.txt' },
      { type: 'blob', path: 'dirx/c.txt' },
      { type: 'blob', path: 'other.txt' },
    ],
  };

  function contents(url: string): Response | undefined {
    if (url.includes('/contents/dir/a.txt')) return fileJson('A');
    if (url.includes('/contents/dir/sub/b.txt')) return fileJson('B');
    if (url.includes('/contents/dir?')) return json([{ type: 'file' }]);
    return undefined;
  }

  it('lists the tree and fetches every blob under the directory', async () => {
    routeFetch((url) => {
      if (url.includes('/git/trees/main?recursive=1')) return json(tree);
      return contents(url) ?? unexpected(url);
    });

    const result = await fetchGitHub('o/r', 'dir', 'main');
    expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
    expect(result.files.get('a.txt')?.toString()).toBe('A');
  });

  it('skips the path probe for a trailing slash', async () => {
    const fetchSpy = routeFetch((url) => {
      if (url.includes('/git/trees/')) return json(tree);
      return contents(url) ?? unexpected(url);
    });

    const result = await fetchGitHub('o/r', 'dir/', 'main');
    expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
    expect(
      fetchSpy.mock.calls.some((c) => urlOf(c[0]).includes('/contents/dir?')),
    ).toBe(false);
  });

  it('throws when the tree is truncated', async () => {
    routeFetch(() => json({ truncated: true, tree: [] }));
    await expect(fetchGitHub('o/r', 'dir/', 'main')).rejects.toThrow(
      'exceeds the GitHub Trees API limit',
    );
  });

  it('throws when the directory is empty', async () => {
    routeFetch(() => json({ truncated: false, tree: [] }));
    await expect(fetchGitHub('o/r', 'dir/', 'main')).rejects.toThrow(
      'Failed to fetch dir/ from o/r@main (not a file or empty directory)',
    );
  });

  it('throws when a listed blob turns out to be a directory', async () => {
    routeFetch((url) => {
      if (url.includes('/git/trees/'))
        return json({
          truncated: false,
          tree: [{ type: 'blob', path: 'dir/a.txt' }],
        });
      return json([]);
    });
    await expect(fetchGitHub('o/r', 'dir/', 'main')).rejects.toThrow(
      'Expected a file but got a directory: dir/a.txt',
    );
  });

  it('throws the HTTP error for a non-fallback tree status', async () => {
    routeFetch(() => json({ message: 'nope' }, 422));
    await expect(fetchGitHub('o/r', 'dir/', 'main')).rejects.toThrow(
      'Failed to list tree dir in o/r@main: HTTP 422: nope',
    );
  });

  it('throws the HTTP error on tree 404 when gh is unavailable', async () => {
    routeFetch(() => new Response('', { status: 404 }));
    routeGh(() => undefined, false);
    await expect(fetchGitHub('o/r', 'dir/', 'main')).rejects.toThrow(
      'Failed to list tree dir in o/r@main: HTTP 404',
    );
  });

  it('rethrows a tree network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitHub('o/r', 'dir/', 'main', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });
});

describe('github — directories via gh', () => {
  function ghTree(args: string[]): SpawnOut | undefined {
    const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
    if (endpoint.includes('/git/trees/'))
      return { stdout: 'dir/a.txt\ndir/sub/b.txt\n' };
    if (endpoint.includes('/contents/dir/a.txt')) return { stdout: b64('A') };
    if (endpoint.includes('/contents/dir/sub/b.txt'))
      return { stdout: b64('B') };
    if (endpoint.includes('/contents/dir?')) return { stdout: 'directory\n' };
    return undefined;
  }

  it('via: cli lists and fetches the directory with gh', async () => {
    routeFetch((url) => unexpected(url));
    const calls = routeGh(ghTree);

    const result = await fetchGitHub('o/r', 'dir', 'main', undefined, 'cli');
    expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
    const treeCall = calls.find((c) => c.some((a) => a.includes('git/trees')));
    expect(treeCall?.at(-1)).toContain('startswith("dir/")');
  });

  it('falls back to gh when the tree API returns 403', async () => {
    routeFetch((url) => {
      if (url.includes('/git/trees/')) return new Response('', { status: 403 });
      if (url.includes('/contents/dir/a.txt')) return fileJson('A');
      if (url.includes('/contents/dir/sub/b.txt')) return fileJson('B');
      return unexpected(url);
    });
    routeGh(ghTree);

    const result = await fetchGitHub('o/r', 'dir/', 'main');
    expect(keys(result.files)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('falls back to gh when the tree API has a network error', async () => {
    routeFetch((url) => {
      if (url.includes('/git/trees/')) return networkError();
      if (url.includes('/contents/dir/a.txt')) return fileJson('A');
      if (url.includes('/contents/dir/sub/b.txt')) return fileJson('B');
      return unexpected(url);
    });
    routeGh(ghTree);

    const result = await fetchGitHub('o/r', 'dir/', 'main');
    expect(result.files.size).toBe(2);
  });

  it('via: [cli, api] falls back to the API when gh tree listing fails', async () => {
    routeFetch((url) => {
      if (url.includes('/git/trees/'))
        return json({
          truncated: false,
          tree: [{ type: 'blob', path: 'dir/a.txt' }],
        });
      if (url.includes('/contents/dir/a.txt')) return fileJson('A');
      return unexpected(url);
    });
    routeGh((args) =>
      args.some((a) => a.includes('git/trees'))
        ? { stderr: 'gh tree failed', status: 1 }
        : { stderr: 'gh contents failed', status: 1 },
    );

    const result = await fetchGitHub('o/r', 'dir/', 'main', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('a.txt')?.toString()).toBe('A');
  });

  it('via: cli reports a truncated tree', async () => {
    routeGh(() => ({ stderr: 'error: truncated', status: 1 }));
    await expect(
      fetchGitHub('o/r', 'dir/', 'main', undefined, 'cli'),
    ).rejects.toThrow('exceeds the GitHub Trees API limit');
  });

  it('via: cli reports other tree errors', async () => {
    routeGh(() => ({ stderr: 'not found', status: 1 }));
    await expect(
      fetchGitHub('o/r', 'dir/', 'main', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tree dir in o/r@main: not found');
  });
});

describe('github — ref resolution via API', () => {
  const fileUrl = '/contents/f.txt';

  it('pattern: paginates tags until a match', async () => {
    routeFetch((url) => {
      if (url.includes('/tags?per_page=100&page=1'))
        return json(tagPage(filler(100)));
      if (url.includes('/tags?per_page=100&page=2'))
        return json(tagPage(['v1.5.0']));
      if (url.includes(`${fileUrl}?ref=v1.5.0`)) return fileJson('p');
      return unexpected(url);
    });
    const result = await fetchGitHub('o/r', 'f.txt', '/^v1\\./');
    expect(result.files.get('f.txt')?.toString()).toBe('p');
  });

  it('pattern: falls back to gh on network error', async () => {
    routeFetch((url) =>
      url.includes('/tags') ? networkError() : fileJson('ok'),
    );
    routeGh(() => ({ stdout: 'v2.0.0\nv1.2.0\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '/^v1\\./');
    expect(result.files.get('f.txt')?.toString()).toBe('ok');
  });

  it('pattern: falls back to gh on 401', async () => {
    const fetchSpy = routeFetch((url) =>
      url.includes('/tags')
        ? new Response('', { status: 401 })
        : fileJson('ok'),
    );
    routeGh(() => ({ stdout: 'v1.2.0\n' }));
    await fetchGitHub('o/r', 'f.txt', '/^v1\\./');
    expect(urlOf(fetchSpy.mock.calls.at(-1)?.[0])).toContain('ref=v1.2.0');
  });

  it('pattern: throws non-fallback HTTP errors', async () => {
    routeFetch(() => json({ message: 'invalid' }, 422));
    await expect(fetchGitHub('o/r', 'f.txt', '/^v1\\./')).rejects.toThrow(
      'Failed to list tags for o/r: HTTP 422: invalid',
    );
  });

  it('pattern: throws on 401 when gh is unavailable', async () => {
    routeFetch(() => new Response('', { status: 401 }));
    routeGh(() => undefined, false);
    await expect(fetchGitHub('o/r', 'f.txt', '/^v1\\./')).rejects.toThrow(
      'HTTP 401',
    );
  });

  it('$latest: picks the highest semver tag across pages when there is no release', async () => {
    routeFetch((url) => {
      if (url.endsWith('/releases/latest'))
        return new Response('', { status: 404 });
      if (url.includes('/tags?per_page=100&page=1'))
        return json(tagPage(['v1.0.0', 'v3.0.0', ...filler(98)]));
      if (url.includes('/tags?per_page=100&page=2'))
        return json(tagPage(['v2.0.0', 'v3.1.0']));
      if (url.includes(`${fileUrl}?ref=v3.1.0`)) return fileJson('latest');
      return unexpected(url);
    });
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('latest');
  });

  it('$latest: keeps the earlier best when a later page is lower', async () => {
    routeFetch((url) => {
      if (url.endsWith('/releases/latest'))
        return new Response('', { status: 404 });
      if (url.includes('&page=1'))
        return json(tagPage(['v3.0.0', ...filler(99)]));
      if (url.includes('&page=2')) return json(tagPage(['v2.0.0']));
      if (url.includes(`${fileUrl}?ref=v3.0.0`)) return fileJson('best');
      return unexpected(url);
    });
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('best');
  });

  it('$latest: throws when no semver tags exist', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/latest')
        ? new Response('', { status: 404 })
        : json(tagPage(['nightly'])),
    );
    await expect(fetchGitHub('o/r', 'f.txt', '$latest')).rejects.toThrow(
      'No semver tags found for o/r (needed to resolve $latest)',
    );
  });

  it('$latest: falls back to gh on a releases network error', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/latest') ? networkError() : fileJson('ok'),
    );
    routeGh(() => ({ stdout: 'v1.0.0\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('ok');
  });

  it('$latest: rethrows a releases network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('$latest: falls back to gh when releases/latest returns 401', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/latest')
        ? new Response('', { status: 401 })
        : fileJson('ok'),
    );
    routeGh(() => ({ stdout: 'v1.0.0\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('ok');
  });

  it('$latest: throws non-fallback releases/latest errors', async () => {
    routeFetch(() => json({ message: 'weird' }, 422));
    await expect(fetchGitHub('o/r', 'f.txt', '$latest')).rejects.toThrow(
      'Failed to resolve "$latest" for o/r: HTTP 422: weird',
    );
  });

  it('$latest: falls back to gh on a tag scan network error', async () => {
    routeFetch((url) => {
      if (url.endsWith('/releases/latest'))
        return new Response('', { status: 404 });
      if (url.includes('/tags')) return networkError();
      return fileJson('ok');
    });
    routeGh(() => ({ stdout: 'v1.0.0\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('ok');
  });

  it('$latest: falls back to gh on a tag scan 403', async () => {
    routeFetch((url) => {
      if (url.endsWith('/releases/latest'))
        return new Response('', { status: 404 });
      if (url.includes('/tags')) return new Response('', { status: 403 });
      return fileJson('ok');
    });
    routeGh(() => ({ stdout: 'v1.0.0\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '$latest');
    expect(result.files.get('f.txt')?.toString()).toBe('ok');
  });

  it('$latest: throws a tag scan error when gh is unavailable', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/latest')
        ? new Response('', { status: 404 })
        : new Response('', { status: 403 }),
    );
    routeGh(() => undefined, false);
    await expect(fetchGitHub('o/r', 'f.txt', '$latest')).rejects.toThrow(
      'Failed to list tags for o/r: HTTP 403',
    );
  });

  it('$recent: rethrows a network error with via: api', async () => {
    routeFetch(() => networkError());
    await expect(
      fetchGitHub('o/r', 'f.txt', '$recent', undefined, 'api'),
    ).rejects.toThrow('fetch failed');
  });

  it('$recent: throws when the repo has no tags', async () => {
    routeFetch(() => json([]));
    await expect(fetchGitHub('o/r', 'f.txt', '$recent')).rejects.toThrow(
      'No tags found for o/r (needed to resolve $recent)',
    );
  });

  it('$recent: falls back to gh on 404', async () => {
    routeFetch((url) =>
      url.includes('/tags') ? new Response('', { status: 404 }) : fileJson('r'),
    );
    routeGh(() => ({ stdout: 'nightly\n' }));
    const result = await fetchGitHub('o/r', 'f.txt', '$recent');
    expect(result.files.get('f.txt')?.toString()).toBe('r');
  });

  it('$recent: throws non-fallback HTTP errors', async () => {
    routeFetch(() => new Response('', { status: 422 }));
    await expect(fetchGitHub('o/r', 'f.txt', '$recent')).rejects.toThrow(
      'Failed to resolve "$recent" for o/r: HTTP 422',
    );
  });
});

describe('github — ref resolution via gh', () => {
  function withFile(
    handler: (args: string[]) => SpawnOut | undefined,
  ): (args: string[]) => SpawnOut | undefined {
    return (args) =>
      args.some((a) => a.includes('/contents/'))
        ? { stdout: b64('content') }
        : handler(args);
  }

  it('pattern: returns the first matching tag', async () => {
    const calls = routeGh(withFile(() => ({ stdout: 'v2.0.0\nv1.3.0\n' })));
    await fetchGitHub('o/r', 'f.txt', '/^v1\\./', undefined, 'cli');
    expect(calls.at(-1)?.some((a) => a.includes('ref=v1.3.0'))).toBe(true);
  });

  it('pattern: throws when nothing matches', async () => {
    routeGh(() => ({ stdout: 'v2.0.0\n' }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '/^v9\\./', undefined, 'cli'),
    ).rejects.toThrow('No tags matching "/^v9\\./" found for o/r');
  });

  it('pattern: reports gh failures with stderr', async () => {
    routeGh(() => ({ stderr: 'rate limited\n', status: 1 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '/^v9\\./', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tags for o/r: rate limited');
  });

  it('pattern: reports gh failures without stderr', async () => {
    routeGh(() => ({ status: 3 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '/^v9\\./', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tags for o/r: gh exited with status 3');
  });

  it('$latest: scans tags when the release is not semver', async () => {
    const calls = routeGh(
      withFile((args) =>
        args.some((a) => a.endsWith('/releases/latest'))
          ? { stdout: 'nightly\n' }
          : { stdout: 'v1.0.0\nv1.10.0\nv1.9.0\n' },
      ),
    );
    await fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'cli');
    expect(calls.at(-1)?.some((a) => a.includes('ref=v1.10.0'))).toBe(true);
  });

  it('$latest: scans tags when releases/latest fails', async () => {
    const calls = routeGh(
      withFile((args) =>
        args.some((a) => a.endsWith('/releases/latest'))
          ? { stderr: 'Not Found', status: 1 }
          : { stdout: 'v0.1.0\n' },
      ),
    );
    await fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'cli');
    expect(calls.at(-1)?.some((a) => a.includes('ref=v0.1.0'))).toBe(true);
  });

  it('$latest: throws when no semver tags exist', async () => {
    routeGh((args) =>
      args.some((a) => a.endsWith('/releases/latest'))
        ? { stdout: '' }
        : { stdout: 'nightly\n' },
    );
    await expect(
      fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'cli'),
    ).rejects.toThrow(
      'No semver tags found for o/r (needed to resolve $latest)',
    );
  });

  it('$latest: reports tag listing failures', async () => {
    routeGh((args) =>
      args.some((a) => a.endsWith('/releases/latest'))
        ? { status: 1 }
        : { stderr: 'forbidden', status: 1 },
    );
    await expect(
      fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tags for o/r: forbidden');
  });

  it('$latest: reports tag listing failures without stderr', async () => {
    routeGh(() => ({ status: 2 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '$latest', undefined, 'cli'),
    ).rejects.toThrow('gh exited with status 2');
  });

  it('$recent: reports gh failures', async () => {
    routeGh(() => ({ stderr: 'denied', status: 1 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '$recent', undefined, 'cli'),
    ).rejects.toThrow('Failed to list tags for o/r: denied');
  });

  it('$recent: reports gh failures without stderr', async () => {
    routeGh(() => ({ status: 4 }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '$recent', undefined, 'cli'),
    ).rejects.toThrow('gh exited with status 4');
  });

  it('$recent: throws when gh returns null', async () => {
    routeGh(() => ({ stdout: 'null\n' }));
    await expect(
      fetchGitHub('o/r', 'f.txt', '$recent', undefined, 'cli'),
    ).rejects.toThrow('No tags found for o/r (needed to resolve $recent)');
  });

  it('via: [cli, api] falls back to the API when gh ref resolution fails', async () => {
    routeFetch((url) => {
      if (url.includes('/tags?per_page=1')) return json(tagPage(['from-api']));
      if (url.includes('ref=from-api')) return fileJson('api');
      return unexpected(url);
    });
    routeGh(() => ({ stderr: 'gh down', status: 1 }));
    const result = await fetchGitHub('o/r', 'f.txt', '$recent', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('f.txt')?.toString()).toBe('api');
  });
});

describe('github — releases via API', () => {
  const releaseUrl = '/releases/tags/v1.0.0';
  const assets = [
    { id: 1, name: 'tool-linux.tar.gz' },
    { id: 2, name: 'tool-darwin.tar.gz' },
    { id: 3, name: 'checksums.txt' },
  ];

  function releaseRoutes(url: string): Response {
    if (url.endsWith(releaseUrl)) return json({ assets });
    const m = /\/releases\/assets\/(\d+)$/.exec(url);
    if (m) return new Response(`asset-${m[1]}`);
    return unexpected(url);
  }

  it('applies the pre-filter before downloading', async () => {
    const fetchSpy = routeFetch(releaseRoutes);
    const result = await fetchGitHubRelease(
      'o/r',
      'v1.0.0',
      undefined,
      undefined,
      ['*-linux.tar.gz'],
    );
    expect([...result.files.keys()]).toEqual(['tool-linux.tar.gz']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const dlInit = fetchSpy.mock.calls[1][1];
    expect((dlInit?.headers as Record<string, string>).Accept).toBe(
      'application/octet-stream',
    );
  });

  it('returns an empty map when the pre-filter matches nothing', async () => {
    routeFetch(releaseRoutes);
    const result = await fetchGitHubRelease(
      'o/r',
      'v1.0.0',
      undefined,
      undefined,
      ['*.exe'],
    );
    expect(result.files.size).toBe(0);
  });

  it('throws non-fallback release errors', async () => {
    routeFetch(() => json({ message: 'nah' }, 422));
    await expect(fetchGitHubRelease('o/r', 'v1.0.0')).rejects.toThrow(
      'Failed to fetch release v1.0.0 from o/r: HTTP 422: nah',
    );
  });

  it('throws on 404 when gh is unavailable', async () => {
    routeFetch(() => new Response('', { status: 404 }));
    routeGh(() => undefined, false);
    await expect(fetchGitHubRelease('o/r', 'v1.0.0')).rejects.toThrow(
      'Failed to fetch release v1.0.0 from o/r: HTTP 404',
    );
  });

  it('throws when an asset download fails', async () => {
    routeFetch((url) =>
      url.endsWith(releaseUrl)
        ? json({ assets: [assets[0]] })
        : new Response('', { status: 410 }),
    );
    await expect(fetchGitHubRelease('o/r', 'v1.0.0')).rejects.toThrow(
      'Failed to download release asset "tool-linux.tar.gz" from o/r@v1.0.0: HTTP 410',
    );
  });
});

describe('github — releases via gh', () => {
  function dirArg(args: string[]): string {
    return args[args.indexOf('--dir') + 1];
  }

  function writeAssets(args: string[], names: string[]): SpawnOut {
    const dir = dirArg(args);
    for (const n of names) fs.writeFileSync(path.join(dir, n), `data:${n}`);
    fs.mkdirSync(path.join(dir, 'subdir'));
    return {};
  }

  function patternArgs(args: string[]): string[] {
    return args.flatMap((a, i) => (args[i - 1] === '--pattern' ? [a] : []));
  }

  it('via: cli downloads all assets', async () => {
    routeFetch((url) => unexpected(url));
    const calls = routeGh((args) => writeAssets(args, ['a.zip', 'b.zip']));
    const result = await fetchGitHubRelease(
      'o/r',
      'v1.0.0',
      'ghe.example.com',
      'cli',
    );
    expect([...result.files.keys()].sort()).toEqual(['a.zip', 'b.zip']);
    expect(result.files.get('a.zip')?.toString()).toBe('data:a.zip');
    expect(calls[0]).toContain('--hostname');
    expect(fs.existsSync(dirArg(calls[0]))).toBe(false);
  });

  it('passes expanded glob filters as --pattern', async () => {
    const calls = routeGh((args) =>
      writeAssets(args, ['tool-amd64.tgz', 'tool-arm64.tgz', 'notes.txt']),
    );
    const result = await fetchGitHubRelease('o/r', 'v1.0.0', undefined, 'cli', [
      'tool-{amd64,arm64}.tgz',
      '*.md',
    ]);
    expect(patternArgs(calls[0])).toEqual([
      'tool-amd64.tgz',
      'tool-arm64.tgz',
      '*.md',
    ]);
    expect([...result.files.keys()].sort()).toEqual([
      'tool-amd64.tgz',
      'tool-arm64.tgz',
    ]);
  });

  it('omits --pattern when any filter is a regex', async () => {
    const calls = routeGh((args) =>
      writeAssets(args, ['tool-amd64.tgz', 'notes.txt']),
    );
    const result = await fetchGitHubRelease('o/r', 'v1.0.0', undefined, 'cli', [
      '/amd64/',
      'x.txt',
    ]);
    expect(patternArgs(calls[0])).toEqual([]);
    expect([...result.files.keys()]).toEqual(['tool-amd64.tgz']);
  });

  it('returns an empty map when filtered download yields nothing', async () => {
    routeGh(() => ({}));
    const result = await fetchGitHubRelease('o/r', 'v1.0.0', undefined, 'cli', [
      '*.exe',
    ]);
    expect(result.files.size).toBe(0);
  });

  it('throws when the release has no assets', async () => {
    routeGh(() => ({}));
    await expect(
      fetchGitHubRelease('o/r', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('No release assets found for o/r@v1.0.0');
  });

  it('via: [cli, api] falls back to the API when gh download fails', async () => {
    routeFetch((url) =>
      url.endsWith('/releases/tags/v1.0.0')
        ? json({ assets: [{ id: 7, name: 'x.bin' }] })
        : new Response('api-bytes'),
    );
    routeGh(() => ({ stderr: 'gh failed', status: 1 }));
    const result = await fetchGitHubRelease('o/r', 'v1.0.0', undefined, [
      'cli',
      'api',
    ]);
    expect(result.files.get('x.bin')?.toString()).toBe('api-bytes');
  });

  it('via: cli rethrows gh download failures', async () => {
    routeGh(() => ({ stderr: 'gh failed', status: 1 }));
    await expect(
      fetchGitHubRelease('o/r', 'v1.0.0', undefined, 'cli'),
    ).rejects.toThrow('Failed to download release v1.0.0 from o/r: gh failed');
  });

  it('falls back to gh when the release API returns 403', async () => {
    routeFetch(() => new Response('', { status: 403 }));
    routeGh((args) => writeAssets(args, ['c.bin']));
    const result = await fetchGitHubRelease('o/r', 'v1.0.0');
    expect(result.files.get('c.bin')?.toString()).toBe('data:c.bin');
  });
});
