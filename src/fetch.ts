import { verbose, isVerbose } from './logger';

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

function isSensitiveParam(k: string): boolean {
  const lower = k.toLowerCase();
  // Generic names
  if (
    [
      'token',
      'access_token',
      'api_key',
      'key',
      'secret',
      'password',
      'auth',
      'sig',
      'signature',
    ].includes(lower)
  )
    return true;
  // AWS pre-signed URL params (X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token, …)
  if (lower.startsWith('x-amz-')) return true;
  // GCP pre-signed URL params (X-Goog-Signature, X-Goog-Credential, …)
  if (lower.startsWith('x-goog-')) return true;
  return false;
}

export function redactUrl(raw: string): string {
  let result = raw;
  try {
    const u = new URL(raw);
    // Strip basic-auth credentials from the URL authority
    u.username = '';
    u.password = '';
    for (const k of u.searchParams.keys()) {
      if (isSensitiveParam(k)) u.searchParams.set(k, '***');
    }
    result = u.toString();
  } catch {
    // URL parsing failed; result stays as raw
  }
  // Strip any remaining //user:pass@ (handles opaque-path URLs where the nested
  // scheme's userinfo is invisible to the outer URL parser, e.g. git:git+ssh://user:pass@host)
  result = result.replace(/(\/\/)[^@]*@/, '$1***@');
  // Strip scp-style user:pass@ patterns (userinfo contains ':') not already caught above
  return result.replace(/(?<!\/\/)([^/:@\s]+:[^/:@\s]+)@/g, '***@');
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  if (isVerbose()) {
    const method = (options.method ?? 'GET').toUpperCase();
    verbose(`${method} ${redactUrl(url)}`);
  }
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (isVerbose()) {
        const err = e instanceof Error ? e : new Error(String(e));
        const cause =
          'cause' in err && err.cause instanceof Error ? err.cause : null;
        const causeMsg = cause ? `: ${cause.message}` : '';
        verbose(`  -> network error: ${err.message}${causeMsg}`);
      }
      throw e;
    }
    if (isVerbose()) verbose(`  -> HTTP ${res.status}`);
    const shouldRetry =
      res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!shouldRetry || attempt >= MAX_RETRIES) return res;
    const delay = retryDelayMs(attempt, res.headers);
    if (isVerbose())
      verbose(`  -> retrying in ${delay}ms (status ${res.status})`);
    await _testable.sleep(delay);
  }
}
