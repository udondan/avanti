import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../../fetch';
import { compilePatterns, matchesAnyPattern } from '../../filter';
import { verbose } from '../../logger';
import type { Via } from '../../types';
import {
  apiOrCli,
  firstNonEmpty,
  HttpError,
  normalizeVia,
  withTransports,
} from '../forge/transport';
import { resolveToken } from './auth';
import {
  apiHeaders,
  envToken,
  getHost,
  GLAB,
  glabApi,
  type GitLabResult,
  projectEndpoint,
} from './client';
import {
  downloadLink,
  type GitLabReleaseLink,
  rewriteToApiUploadUrl,
} from './release-download';
import { resolveReleaseTag } from './release-tag';

/** Prefers `package` links; falls back to all links. */
function pickLinks(all: GitLabReleaseLink[]): GitLabReleaseLink[] {
  const packages = all.filter((l) => l.link_type === 'package');
  return packages.length ? packages : all;
}

function filterLinks(
  links: GitLabReleaseLink[],
  preFilter?: string[],
): GitLabReleaseLink[] {
  if (!preFilter || preFilter.length === 0) return links;
  const compiled = compilePatterns(preFilter);
  return links.filter((l) =>
    matchesAnyPattern(path.basename(l.name), compiled),
  );
}

function apiUploadUrlFor(
  link: GitLabReleaseLink,
  gitlabHost: string,
  hasToken: boolean,
): string | undefined {
  const urlHost = new URL(link.url).host;
  return hasToken && urlHost === gitlabHost
    ? rewriteToApiUploadUrl(link.url)
    : undefined;
}

function releaseSuffix(tag: string): string {
  return `releases/${encodeURIComponent(tag)}`;
}

function noAssetsError(project: string, tag: string): Error {
  return new Error(`No release assets found for ${project}@${tag}`);
}

async function fetchReleaseLinksViaApi(
  project: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Promise<Map<string, Buffer>> {
  const rawHost = getHost(host);
  const gitlabHost = new URL(`https://${rawHost}`).host;
  const res = await fetchWithRetry(
    `https://${gitlabHost}/api/v4/${projectEndpoint(project, releaseSuffix(tag))}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `Failed to fetch release ${tag} from ${project}: HTTP ${res.status}`,
    );
  }
  const rel = (await res.json()) as {
    assets: { links: GitLabReleaseLink[] };
  };
  const all = pickLinks(rel.assets.links);
  if (!all.length) throw noAssetsError(project, tag);
  const links = filterLinks(all, preFilter);
  if (links.length === 0) return new Map();
  const hasToken = !!envToken();
  const headersFor = (url: string) =>
    new URL(url).host === gitlabHost
      ? apiHeaders()
      : { 'User-Agent': 'avanti' };
  const entries = await Promise.all(
    links.map((link) =>
      downloadLink({
        link,
        gitlabHost,
        // Only rewrite to the API upload path when a token is available and the
        // link URL is on the known GitLab host — external links must not be rewritten.
        apiUploadUrl: apiUploadUrlFor(link, gitlabHost, hasToken),
        headersFor,
        source: `${project}@${tag}`,
      }),
    ),
  );
  return new Map(entries);
}

// Pre-determine the trusted GitLab host for token scoping from the FULL link
// list (before any preFilter is applied) so that host inference is not
// affected by which links the filter keeps. Priority order:
// 1. Explicit config (host:/GITLAB_HOST) — authoritative
// 2. Any link's direct_asset_url host — direct_asset_url always points to the
//    GitLab instance, so any occurrence across the link set reliably identifies it
// 3. undefined — fall back per-link to link.url's host (old GitLab instances
//    that never populate direct_asset_url; all links are same-host there)
function inferGitlabHost(
  links: GitLabReleaseLink[],
  host?: string,
): string | undefined {
  const explicitGitlabHost = firstNonEmpty(host, process.env.GITLAB_HOST);
  return (
    explicitGitlabHost ??
    links
      .map((l) =>
        l.direct_asset_url ? new URL(l.direct_asset_url).host : null,
      )
      .find((h): h is string => h !== null)
  );
}

async function downloadLinksWithToken(
  links: GitLabReleaseLink[],
  token: string,
  knownGitlabHost: string | undefined,
  source: string,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const link of links) {
    const urlHost = new URL(link.url).host;
    // Use the pre-computed GitLab host if known; otherwise fall back to the
    // link.url host (link.url is always a GitLab URL, unlike direct_asset_url
    // which can redirect to external S3/GCS). Normalize the ssh. prefix.
    const gitlabHost = (knownGitlabHost ?? urlHost).replace(/^ssh\./, '');
    const headersFor = (url: string) => {
      const headers: Record<string, string> = { 'User-Agent': 'avanti' };
      if (new URL(url).host === gitlabHost) headers['PRIVATE-TOKEN'] = token;
      return headers;
    };
    const [name, content] = await downloadLink({
      link,
      gitlabHost,
      // Rewrite upload URLs to the API path which supports PRIVATE-TOKEN auth.
      // Web upload URLs (/-/project/<id>/uploads/...) drop the token on redirect.
      // Only rewrite links on the known GitLab host; external links must not be rewritten.
      apiUploadUrl:
        urlHost === gitlabHost ? rewriteToApiUploadUrl(link.url) : undefined,
      headersFor,
      source,
    });
    files.set(name, content);
  }
  return files;
}

// No token resolvable. Last resort: glab release download, which uses
// glab's own authenticated HTTP client. NOTE: this will fail with 404 for
// GitLab instances where the External URL has a trailing slash (the same
// double-slash URL bug). Set GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN to use
// the authenticated HTTP fetch path instead.
function downloadLinksViaGlab(
  links: GitLabReleaseLink[],
  project: string,
  tag: string,
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-glab-'));
  try {
    const args = ['release', 'download', tag, '-R', project, '-D', tmpDir];
    // glab release download has no asset-name/pattern flag that allows
    // selecting individual assets; it downloads all of them. The pre-filtered
    // links array already holds only the matching assets, so the read loop
    // below picks up only those files from the temp dir.
    verbose(`gitlab: glab ${args.join(' ')}`);
    const dlRes = spawnSync('glab', args, { encoding: 'utf8' });
    if (dlRes.error) throw new Error(`glab error: ${dlRes.error.message}`);
    if (dlRes.status !== 0) {
      throw new Error(
        `glab release download failed (exit ${dlRes.status}): ${dlRes.stderr}`,
      );
    }
    for (const link of links) {
      const name = path.basename(link.name);
      const fp = path.join(tmpDir, name);
      if (fs.existsSync(fp)) files.set(name, fs.readFileSync(fp));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return files;
}

async function fetchReleaseLinksViaCli(
  project: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Promise<Map<string, Buffer>> {
  const metaRes = glabApi(projectEndpoint(project, releaseSuffix(tag)), host);
  if (metaRes.status !== 0) {
    throw new Error(
      `Failed to fetch release ${tag} from ${project}: ${metaRes.stderr}`,
    );
  }
  const rel = JSON.parse(metaRes.stdout) as {
    assets?: { links?: GitLabReleaseLink[] };
  };
  const all = pickLinks(rel.assets?.links ?? []);
  if (!all.length) throw noAssetsError(project, tag);
  const knownGitlabHost = inferGitlabHost(all, host);
  const links = filterLinks(all, preFilter);
  if (links.length === 0) return new Map();
  // Resolve after knownGitlabHost so we can pass the inferred host (from
  // direct_asset_url) when no explicit host is configured. This lets resolveToken
  // issue a --hostname-scoped glab auth lookup even without an explicit host: config,
  // preventing a multi-instance glab config from returning the wrong instance's token.
  const token = resolveToken(knownGitlabHost ?? host);

  const files = token
    ? await downloadLinksWithToken(
        links,
        token,
        knownGitlabHost,
        `${project}@${tag}`,
      )
    : downloadLinksViaGlab(links, project, tag);

  if (!files.size) throw noAssetsError(project, tag);
  return files;
}

export async function fetchGitLabRelease(
  project: string,
  release: string,
  host?: string,
  via?: Via | Via[],
  preFilter?: string[],
): Promise<GitLabResult> {
  const transports = normalizeVia(via);
  const tag = await resolveReleaseTag(project, release, host, transports);
  verbose(`gitlab: fetching release assets for ${project}@${tag}`);

  const viaCli = async () => ({
    files: await fetchReleaseLinksViaCli(project, tag, host, preFilter),
  });
  return withTransports(transports, viaCli, (withCliFallback) =>
    apiOrCli(
      GLAB,
      withCliFallback,
      async () => ({
        files: await fetchReleaseLinksViaApi(project, tag, host, preFilter),
      }),
      viaCli,
    ),
  );
}
