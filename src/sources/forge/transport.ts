import { fetchWithRetry } from '../../fetch';
import { verbose } from '../../logger';
import type { Via } from '../../types';

/** Describes a forge's CLI used as a fallback transport for its HTTP API. */
export interface ForgeCli {
  /** Log prefix, e.g. `github`. */
  prefix: string;
  /** CLI binary name, e.g. `gh`. */
  cli: string;
  isAvailable: () => boolean;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function normalizeVia(via?: Via | Via[]): Via[] {
  if (!via) return ['api', 'cli'];
  if (Array.isArray(via)) {
    if (via.length === 0) throw new Error('via: array must not be empty');
    return [...via];
  }
  return [via];
}

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && e.message === 'fetch failed';
}

/** True when the API is the primary transport and the CLI is configured as fallback. */
export function cliFallbackAllowed(transports: Via[]): boolean {
  return transports[0] === 'api' && transports.includes('cli');
}

/** True when CLI fallback is configured and the CLI binary is available. */
export function canUseCli(forge: ForgeCli, withCliFallback: boolean): boolean {
  return withCliFallback && forge.isAvailable();
}

/** True when an HTTP status allows falling back to the CLI. */
export function statusFallback(
  forge: ForgeCli,
  status: number,
  withCliFallback: boolean,
): boolean {
  return shouldFallback(status) && canUseCli(forge, withCliFallback);
}

function networkErrorFallback(
  forge: ForgeCli,
  e: unknown,
  withCliFallback: boolean,
): boolean {
  if (!isNetworkError(e) || !canUseCli(forge, withCliFallback)) return false;
  verbose(`${forge.prefix}: HTTP fetch failed, falling back to ${forge.cli}`);
  return true;
}

function httpErrorFallback(
  forge: ForgeCli,
  e: unknown,
  withCliFallback: boolean,
): boolean {
  if (!(e instanceof HttpError)) return false;
  if (!statusFallback(forge, e.status, withCliFallback)) return false;
  verbose(
    `${forge.prefix}: API returned ${e.status}, falling back to ${forge.cli}`,
  );
  return true;
}

/**
 * Runs the CLI implementation first when `cli` is the primary transport
 * (falling through to the API when `api` is also configured), then the API
 * implementation, which receives whether CLI fallback is allowed.
 */
export async function withTransports<T>(
  transports: Via[],
  cli: () => T | Promise<T>,
  api: (withCliFallback: boolean) => Promise<T>,
): Promise<T> {
  if (transports[0] === 'cli') {
    try {
      return await cli();
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }
  return api(cliFallbackAllowed(transports));
}

/**
 * Fetches an API URL. Returns null when a network error occurred and the
 * caller should fall back to the CLI; rethrows any other error.
 */
export async function fetchApi(
  forge: ForgeCli,
  url: string,
  init: RequestInit,
  withCliFallback: boolean,
): Promise<Response | null> {
  try {
    return await fetchWithRetry(url, init);
  } catch (e) {
    if (networkErrorFallback(forge, e, withCliFallback)) return null;
    throw e;
  }
}

/**
 * Runs an API call; on a network error or a fallback-able HttpError, runs the
 * CLI implementation instead.
 */
export async function apiOrCli<T>(
  forge: ForgeCli,
  withCliFallback: boolean,
  api: () => Promise<T>,
  cli: () => T | Promise<T>,
): Promise<T> {
  try {
    return await api();
  } catch (e) {
    if (
      networkErrorFallback(forge, e, withCliFallback) ||
      httpErrorFallback(forge, e, withCliFallback)
    )
      return cli();
    throw e;
  }
}

/** First value that is non-empty after trimming, or undefined. */
export function firstNonEmpty(
  ...values: (string | undefined)[]
): string | undefined {
  return values.map((v) => v?.trim()).find(Boolean);
}
