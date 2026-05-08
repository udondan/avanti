const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

// Object wrapper so tests can spy on sleep without fake timers
export const _testable = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
};

function retryDelayMs(attempt: number, headers: Headers): number {
  // Retry-After: seconds to wait (GitHub secondary rate limit, GitLab)
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1_000, MAX_DELAY_MS);
  }

  // X-RateLimit-Reset: Unix timestamp when the limit resets (GitHub primary rate limit)
  const resetAt = headers.get('X-RateLimit-Reset');
  if (resetAt) {
    const waitMs = parseInt(resetAt, 10) * 1_000 - Date.now();
    if (waitMs > 0) return Math.min(waitMs, MAX_DELAY_MS);
  }

  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    const shouldRetry =
      res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!shouldRetry || attempt >= MAX_RETRIES) return res;
    await _testable.sleep(retryDelayMs(attempt, res.headers));
  }
}
