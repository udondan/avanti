import * as path from 'path';
import { fetchWithRetry, redactUrl } from '../../fetch';
import { verbose } from '../../logger';

export interface GitLabReleaseLink {
  name: string;
  url: string;
  direct_asset_url?: string;
  link_type: string;
}

// GitLab's web upload URLs (/-/project/<id>/uploads/...) drop the PRIVATE-TOKEN
// header when they redirect, resulting in 404. The equivalent API endpoint
// (/api/v4/projects/<id>/uploads/...) authenticates properly with PRIVATE-TOKEN.
export function rewriteToApiUploadUrl(url: string): string | undefined {
  const m = /^(https?:\/\/[^/]+.*?)\/*\/-\/project\/(\d+)\/uploads\/(.+)$/.exec(
    url,
  );
  if (!m) return undefined;
  return `${m[1]}/api/v4/projects/${m[2]}/uploads/${m[3]}`;
}

// Follows HTTP redirects while ensuring the PRIVATE-TOKEN header is only sent
// to the originating GitLab host, not forwarded to external redirect targets
// (e.g. pre-signed S3/GCS URLs that release assets may redirect to).
async function fetchWithHostBoundRedirects(
  url: string,
  headers: Record<string, string>,
  gitlabHost: string,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = url;
  let currentHeaders = headers;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchWithRetry(currentUrl, {
      headers: currentHeaders,
      redirect: 'manual',
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    const resolvedLocation = new URL(location, currentUrl).href;
    const redirectHost = new URL(resolvedLocation).host;
    currentHeaders =
      redirectHost === gitlabHost ? headers : { 'User-Agent': 'avanti' };
    currentUrl = resolvedLocation;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

interface LinkDownload {
  link: GitLabReleaseLink;
  /** Trusted GitLab host; only requests to it carry credentials. */
  gitlabHost: string;
  /** API upload URL rewritten from link.url, if applicable. */
  apiUploadUrl: string | undefined;
  /** Builds the request headers for a download URL. */
  headersFor: (url: string) => Record<string, string>;
  /** `<project>@<tag>`, used in error messages. */
  source: string;
}

/** Downloads a release link and returns `[basename, content]`. */
export async function downloadLink(d: LinkDownload): Promise<[string, Buffer]> {
  const { link, gitlabHost, apiUploadUrl } = d;
  const downloadUrl = apiUploadUrl ?? link.direct_asset_url ?? link.url;
  const headers = d.headersFor(downloadUrl);
  verbose(`gitlab: downloading ${redactUrl(downloadUrl)}`);
  let dlRes = await fetchWithHostBoundRedirects(
    downloadUrl,
    headers,
    gitlabHost,
  );
  // If the API upload endpoint returns 404 (older GitLab without that endpoint),
  // retry with direct_asset_url as the compatibility fallback.
  const fallback = link.direct_asset_url ?? link.url;
  if (isMissingApiUpload(dlRes, apiUploadUrl) && fallback !== downloadUrl) {
    verbose(
      `gitlab: API upload endpoint not found, retrying with ${redactUrl(fallback)}`,
    );
    // Use a fresh headers object for the retry — the initial headers may
    // contain PRIVATE-TOKEN and must not be forwarded to an external host
    // (e.g. S3/GCS) on the retry.
    dlRes = await fetchWithHostBoundRedirects(
      fallback,
      d.headersFor(fallback),
      gitlabHost,
    );
  }
  if (!dlRes.ok) {
    throw new Error(
      `Failed to download release asset "${link.name}" from ${d.source}: HTTP ${dlRes.status}`,
    );
  }
  return [path.basename(link.name), Buffer.from(await dlRes.arrayBuffer())];
}

function isMissingApiUpload(
  res: Response,
  apiUploadUrl: string | undefined,
): boolean {
  return !res.ok && res.status === 404 && !!apiUploadUrl;
}
