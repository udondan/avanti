import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { fetchWithRetry, _testable } from '../src/fetch';

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

let sleepSpy: MockInstance<
  Parameters<typeof _testable.sleep>,
  ReturnType<typeof _testable.sleep>
>;

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
});
