import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { fetchWithRetry, redactUrl, _testable } from '../src/fetch';
import { setVerbose } from '../src/logger';

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

let sleepSpy: MockInstance<typeof _testable.sleep>;

beforeEach(() => {
  sleepSpy = vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWithRetry', () => {
  it('returns response immediately on 2xx without retrying', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse(200));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('retries on 429 and eventually returns the response', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValue(makeResponse(200));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx and eventually returns the response', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 4xx (e.g., 404)', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse(404));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry on 4xx (e.g., 403)', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse(403));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(403);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('respects Retry-After header delay', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': '30' }))
      .mockResolvedValue(makeResponse(200));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    // The delay should have been 30s (30000ms) from Retry-After
    expect(sleepSpy.mock.calls[0][0]).toBe(30_000);
  });

  it('respects X-RateLimit-Reset header delay', async () => {
    // Set reset to 10 seconds in the future
    const resetAt = Math.floor(Date.now() / 1000) + 10;

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        makeResponse(429, { 'X-RateLimit-Reset': String(resetAt) }),
      )
      .mockResolvedValue(makeResponse(200));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    // The delay should be approximately 10000ms
    const delay = sleepSpy.mock.calls[0][0];
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it.each(['soon', '0'])(
    'falls back to exponential backoff when Retry-After is %j',
    async (retryAfter) => {
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': retryAfter }))
        .mockResolvedValue(makeResponse(200));

      await fetchWithRetry('https://example.com/file');

      expect(sleepSpy.mock.calls[0][0]).toBe(1_000);
    },
  );

  it('falls back to exponential backoff when X-RateLimit-Reset is in the past', async () => {
    const resetAt = Math.floor(Date.now() / 1000) - 10;
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        makeResponse(429, { 'X-RateLimit-Reset': String(resetAt) }),
      )
      .mockResolvedValue(makeResponse(200));

    await fetchWithRetry('https://example.com/file');

    expect(sleepSpy.mock.calls[0][0]).toBe(1_000);
  });

  it('stops after MAX_RETRIES (5) even if still getting 429', async () => {
    // 6 calls total: attempt 0..5 (MAX_RETRIES=5 means we try 6 times then return)
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse(429));

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(429);
    // attempt 0..5 = 6 total calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(sleepSpy).toHaveBeenCalledTimes(5);
  });

  it('uses exponential backoff as default delay when no rate-limit headers', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));

    await fetchWithRetry('https://example.com/file');

    // First retry: attempt=0 → 1000 * 2^0 = 1000ms
    // Second retry: attempt=1 → 1000 * 2^1 = 2000ms
    expect(sleepSpy.mock.calls[0][0]).toBe(1_000);
    expect(sleepSpy.mock.calls[1][0]).toBe(2_000);
  });

  it('passes options through to fetch', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse(200));

    const opts: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    };
    await fetchWithRetry('https://example.com/file', opts);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/file', opts);
  });

  describe('network error verbose logging', () => {
    let stderrSpy: MockInstance;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => {
      setVerbose(false);
    });

    it('logs error with cause when verbose is enabled', async () => {
      setVerbose(true);
      vi.spyOn(global, 'fetch').mockRejectedValue(
        new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 10.0.0.1:443'),
        }),
      );

      await expect(fetchWithRetry('https://example.com/file')).rejects.toThrow(
        'fetch failed',
      );

      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain(
        '-> network error: fetch failed: connect ECONNREFUSED 10.0.0.1:443',
      );
    });

    it('logs error without cause when verbose is enabled', async () => {
      setVerbose(true);
      vi.spyOn(global, 'fetch').mockRejectedValue(
        new TypeError('fetch failed'),
      );

      await expect(fetchWithRetry('https://example.com/file')).rejects.toThrow(
        'fetch failed',
      );

      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('[verbose]   -> network error: fetch failed\n');
      expect(output).not.toContain('-> network error: fetch failed:');
    });

    it('logs a non-Error rejection when verbose is enabled', async () => {
      setVerbose(true);
      vi.spyOn(global, 'fetch').mockRejectedValue('socket hang up');

      await expect(fetchWithRetry('https://example.com/file')).rejects.toBe(
        'socket hang up',
      );

      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('-> network error: socket hang up\n');
    });

    it('does not log network error when verbose is disabled', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(
        new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 10.0.0.1:443'),
        }),
      );

      await expect(fetchWithRetry('https://example.com/file')).rejects.toThrow(
        'fetch failed',
      );

      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('network error');
    });
  });
});

describe('fetchWithRetry — verbose retry logging', () => {
  afterEach(() => {
    setVerbose(false);
  });

  it('logs the retry delay when verbose is enabled', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setVerbose(true);
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));

    await fetchWithRetry('https://example.com/file');

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('-> retrying in 1000ms (status 503)');
  });
});

describe('_testable.sleep', () => {
  it('resolves after the given delay', async () => {
    sleepSpy.mockRestore();
    await expect(_testable.sleep(5)).resolves.toBeUndefined();
  });
});

describe('redactUrl', () => {
  it.each([
    'token',
    'access_token',
    'api_key',
    'key',
    'secret',
    'password',
    'auth',
    'sig',
    'signature',
    'TOKEN',
  ])('redacts the generic sensitive query parameter %s', (param) => {
    expect(redactUrl(`https://example.com/f?${param}=abc`)).toBe(
      `https://example.com/f?${param}=***`,
    );
  });

  it('redacts AWS and GCP pre-signed URL parameters', () => {
    const out = redactUrl(
      'https://example.com/f?X-Amz-Signature=a&X-Goog-Credential=b&page=2',
    );
    expect(out).toContain('X-Amz-Signature=***');
    expect(out).toContain('X-Goog-Credential=***');
    expect(out).toContain('page=2');
  });

  it('leaves non-sensitive query parameters untouched', () => {
    expect(redactUrl('https://example.com/f?ref=main')).toBe(
      'https://example.com/f?ref=main',
    );
  });

  it('strips basic-auth credentials', () => {
    expect(redactUrl('https://user:pass@example.com/f')).toBe(
      'https://example.com/f',
    );
  });

  it('redacts scp-style user:pass@ in strings that are not URLs', () => {
    expect(redactUrl('user:secret@host:repo.git')).toBe('***@host:repo.git');
  });
});
