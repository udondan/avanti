import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/fetch';

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchWithRetry', () => {
  it('returns response immediately on 2xx without retrying', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually returns the response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    // advance timers past the retry delays
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 5xx and eventually returns the response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx (e.g., 404)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(404));
    vi.stubGlobal('fetch', mockFetch);

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 4xx (e.g., 403)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(403));
    vi.stubGlobal('fetch', mockFetch);

    const res = await fetchWithRetry('https://example.com/file');

    expect(res.status).toBe(403);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('respects Retry-After header delay', async () => {
    const sleepSpy = vi.spyOn(global, 'setTimeout');

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': '30' }))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    // The delay should have been 30s (30000ms) from Retry-After
    const delayArgs = sleepSpy.mock.calls.map((c) => c[1]);
    expect(delayArgs).toContain(30_000);
  });

  it('respects X-RateLimit-Reset header delay', async () => {
    const sleepSpy = vi.spyOn(global, 'setTimeout');
    // Set reset to 10 seconds in the future
    const resetAt = Math.floor(Date.now() / 1000) + 10;

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(429, { 'X-RateLimit-Reset': String(resetAt) }),
      )
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    // The delay should be approximately 10000ms
    const delayArgs = sleepSpy.mock.calls.map((c) => c[1]);
    expect(
      delayArgs.some((d) => (d as number) > 0 && (d as number) <= 10_000),
    ).toBe(true);
  });

  it('stops after MAX_RETRIES (5) even if still getting 429', async () => {
    // 6 calls total: attempt 0..5 (MAX_RETRIES=5 means we try 6 times then return)
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(429));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(429);
    // attempt 0..5 = 6 total calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('uses exponential backoff as default delay when no rate-limit headers', async () => {
    const sleepSpy = vi.spyOn(global, 'setTimeout');

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com/file');
    await vi.runAllTimersAsync();
    await promise;

    // First retry: attempt=0 → 1000 * 2^0 = 1000ms
    // Second retry: attempt=1 → 1000 * 2^1 = 2000ms
    const delayArgs = sleepSpy.mock.calls.map((c) => c[1] as number);
    expect(delayArgs[0]).toBe(1_000);
    expect(delayArgs[1]).toBe(2_000);
  });

  it('passes options through to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', mockFetch);

    const opts: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    };
    await fetchWithRetry('https://example.com/file', opts);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/file', opts);
  });
});
