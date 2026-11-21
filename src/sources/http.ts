import * as path from 'path';
import { fetchWithRetry } from '../fetch';

export function inferFilenameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchHttp(url: string): Promise<Buffer>;
export async function fetchHttp(url: string, optional: false): Promise<Buffer>;
export async function fetchHttp(
  url: string,
  optional: true,
): Promise<Buffer | null>;
export async function fetchHttp(
  url: string,
  optional: boolean,
): Promise<Buffer | null>;
export async function fetchHttp(
  url: string,
  optional = false,
): Promise<Buffer | null> {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    if (optional && res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
