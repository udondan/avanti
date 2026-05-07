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

export async function fetchHttp(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}
