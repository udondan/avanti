import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchBitbucket } from '../src/sources/bitbucket';
import { _testable } from '../src/fetch';

function textResponse(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  delete process.env.BITBUCKET_TOKEN;
  delete process.env.BITBUCKET_EMAIL;
  delete process.env.BITBUCKET_HOST;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BITBUCKET_TOKEN;
  delete process.env.BITBUCKET_EMAIL;
  delete process.env.BITBUCKET_HOST;
});

// ── Auth headers ──────────────────────────────────────────────────────────────

describe('fetchBitbucket — auth headers', () => {
  it('sends Basic auth with email:token when BITBUCKET_EMAIL + BITBUCKET_TOKEN are set', async () => {
    process.env.BITBUCKET_EMAIL = 'alice@example.com';
    process.env.BITBUCKET_TOKEN = 'tok123';
    const expected = `Basic ${Buffer.from('alice@example.com:tok123').toString('base64')}`;
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse('data'));

    await fetchBitbucket('ws', 'repo', 'file.txt', 'main');

    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, opts] of mockFetch.mock.calls) {
      const headers = (opts as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe(expected);
    }
  });

  it('sends Bearer auth when only BITBUCKET_TOKEN is set (workspace/repo access token)', async () => {
    process.env.BITBUCKET_TOKEN = 'repo-access-tok';
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse('data'));

    await fetchBitbucket('ws', 'repo', 'file.txt', 'main');

    for (const [, opts] of mockFetch.mock.calls) {
      const headers = (opts as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer repo-access-tok');
    }
  });

  it('sends no Authorization header when no credentials are set', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse('data'));

    await fetchBitbucket('ws', 'repo', 'file.txt', 'main');

    for (const [, opts] of mockFetch.mock.calls) {
      const headers = (opts as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
    }
  });
});

// ── Ref resolution ────────────────────────────────────────────────────────────

describe('fetchBitbucket — ref resolution', () => {
  it('uses an explicit ref without making a ref-resolution request', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', 'v2.0.0');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0] as string).toContain('/src/v2.0.0/');
  });

  it('resolves mainbranch when no ref is provided', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ mainbranch: { name: 'develop' } }))
      .mockResolvedValueOnce(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', undefined);

    expect(mockFetch.mock.calls[1][0] as string).toContain('/src/develop/');
  });

  it('resolves $latest to the newest tag', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ values: [{ name: 'v5.0.0' }] }))
      .mockResolvedValueOnce(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', '$latest');

    expect(mockFetch.mock.calls[0][0] as string).toContain('/refs/tags');
    expect(mockFetch.mock.calls[1][0] as string).toContain('/src/v5.0.0/');
  });

  it('throws when $latest finds no semver tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ values: [] }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', '$latest'),
    ).rejects.toThrow('No semver tags found');
  });

  it('throws when ref resolution request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', undefined),
    ).rejects.toThrow('Failed to resolve ref');
  });

  it('uses BITBUCKET_HOST as the API base', async () => {
    process.env.BITBUCKET_HOST = 'bb.internal.example.com';
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', 'main');

    expect(mockFetch.mock.calls[0][0] as string).toContain(
      'bb.internal.example.com',
    );
  });

  it('$latest picks the highest semver across multiple pages', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ name: 'v1.9.9' }, { name: 'nightly' }],
          next: 'https://api.bitbucket.org/2.0/page2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ name: 'v2.0.0' }, { name: 'v1.8.0' }] }),
      )
      .mockResolvedValueOnce(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', '$latest');

    expect(mockFetch.mock.calls[2][0] as string).toContain('/src/v2.0.0/');
  });

  it('$recent sorts by target.date and returns newest', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ values: [{ name: 'nightly' }] }))
      .mockResolvedValueOnce(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', '$recent');

    expect(mockFetch.mock.calls[0][0] as string).toContain('sort=-target.date');
    expect(mockFetch.mock.calls[1][0] as string).toContain('/src/nightly/');
  });

  it('throws when $recent finds no tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ values: [] }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', '$recent'),
    ).rejects.toThrow('No tags found');
  });

  it('throws when $recent tag request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', '$recent'),
    ).rejects.toThrow('Failed to resolve $recent');
  });

  it('pattern resolves to first matching tag by target.date order', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ name: 'v2.0.0' }, { name: 'v1.9.0' }] }),
      )
      .mockResolvedValueOnce(textResponse('content'));

    await fetchBitbucket('ws', 'repo', 'file.txt', '/^v1\\./');

    expect(mockFetch.mock.calls[0][0] as string).toContain('sort=-target.date');
    expect(mockFetch.mock.calls[1][0] as string).toContain('/src/v1.9.0/');
  });

  it('throws when pattern matches no tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse({ values: [{ name: 'v2.0.0' }] })),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', '/^v99\\./'),
    ).rejects.toThrow('No tags matching "/^v99\\./" found for ws/repo');
  });
});

// ── Single file ───────────────────────────────────────────────────────────────

describe('fetchBitbucket — single file', () => {
  it('returns file content keyed by basename', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResponse('hello'));

    const result = await fetchBitbucket(
      'ws',
      'repo',
      'path/to/readme.txt',
      'main',
    );

    expect(result.files.size).toBe(1);
    expect(result.files.get('readme.txt')?.toString('utf8')).toBe('hello');
  });

  it('throws when the file fetch returns a non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403 }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'file.txt', 'main'),
    ).rejects.toThrow('Failed to fetch');
  });
});

// ── Directory fetch (trailing slash) ─────────────────────────────────────────

describe('fetchBitbucket — directory fetch (trailing slash)', () => {
  it('fetches all files listed by the directory endpoint', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            { type: 'commit_file', path: 'docs/a.txt' },
            { type: 'commit_file', path: 'docs/b.txt' },
          ],
        }),
      )
      .mockResolvedValueOnce(textResponse('content of a'))
      .mockResolvedValueOnce(textResponse('content of b'));

    const result = await fetchBitbucket('ws', 'repo', 'docs/', 'main');

    expect(result.files.size).toBe(2);
    expect(result.files.get('a.txt')?.toString('utf8')).toBe('content of a');
    expect(result.files.get('b.txt')?.toString('utf8')).toBe('content of b');
  });

  it('paginates through multiple pages of directory listings', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'dir/p1.txt' }],
          next: 'https://api.bitbucket.org/2.0/next-page',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'dir/p2.txt' }],
        }),
      )
      .mockResolvedValueOnce(textResponse('page 1 file'))
      .mockResolvedValueOnce(textResponse('page 2 file'));

    const result = await fetchBitbucket('ws', 'repo', 'dir/', 'main');

    expect(result.files.size).toBe(2);
    expect(result.files.get('p1.txt')?.toString('utf8')).toBe('page 1 file');
    expect(result.files.get('p2.txt')?.toString('utf8')).toBe('page 2 file');
  });

  it('recurses into subdirectories', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            { type: 'commit_directory', path: 'src/sub' },
            { type: 'commit_file', path: 'src/root.txt' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'src/sub/deep.txt' }],
        }),
      )
      // listDir processes the directory item first (recursive await), so
      // sub/deep.txt ends up first in paths → its fetchFile call fires first
      .mockResolvedValueOnce(textResponse('deep content'))
      .mockResolvedValueOnce(textResponse('root content'));

    const result = await fetchBitbucket('ws', 'repo', 'src/', 'main');

    expect(result.files.size).toBe(2);
    expect(result.files.get('root.txt')?.toString('utf8')).toBe('root content');
    expect(result.files.get('sub/deep.txt')?.toString('utf8')).toBe(
      'deep content',
    );
  });

  it('throws when the directory listing request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'missing/', 'main'),
    ).rejects.toThrow('Failed to list');
  });

  it('throws when the directory is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ values: [] }),
    );

    await expect(
      fetchBitbucket('ws', 'repo', 'empty/', 'main'),
    ).rejects.toThrow('not a file or empty directory');
  });
});

// ── Directory auto-detection (no trailing slash) ──────────────────────────────

describe('fetchBitbucket — directory auto-detection', () => {
  it('falls back to directory listing when the API returns application/json (directory response)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ type: 'commit_directory' }))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'mydir/file.txt' }],
        }),
      )
      .mockResolvedValueOnce(textResponse('hello'));

    const result = await fetchBitbucket('ws', 'repo', 'mydir', 'main');

    expect(result.files.size).toBe(1);
    expect(result.files.get('file.txt')?.toString('utf8')).toBe('hello');
  });
});
