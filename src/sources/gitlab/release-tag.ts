import { verbose } from '../../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../../ref';
import type { Via } from '../../types';
import {
  canUseCli,
  fetchApi,
  statusFallback,
  withTransports,
} from '../forge/transport';
import { apiHeaders, GLAB, PER_PAGE, projectApiUrl } from './client';
import { resolveRef } from './ref';
import {
  noMatchingReleasesError,
  type Release,
  releasesSuffix,
  resolveReleaseTagViaCli,
} from './release-tag-cli';

interface ReleaseContext {
  project: string;
  release: string;
  host?: string;
  transports: Via[];
  withCliFallback: boolean;
  viaCli: () => string;
}

type ReleasesPage = { releases: Release[] } | { tag: string };

function isReleasesUnavailable(status: number): boolean {
  return status === 404 || status === 403;
}

// Releases endpoint failed for $recent or a pattern: 404/403 means releases are
// unavailable, so fall back to the CLI or to tag resolution.
function releasesPageFailed(ctx: ReleaseContext, status: number) {
  const { project, release, host, transports, withCliFallback } = ctx;
  if (isReleasesUnavailable(status)) {
    if (canUseCli(GLAB, withCliFallback)) return ctx.viaCli();
    return resolveRef(project, release, host, transports);
  }
  if (statusFallback(GLAB, status, withCliFallback)) return ctx.viaCli();
  throw new Error(
    `Failed to resolve "${release}" release for ${project}: HTTP ${status}`,
  );
}

/** Fetches one page of releases (sorted by released_at desc), or the tag resolved by a fallback. */
async function releasesPageViaApi(
  ctx: ReleaseContext,
  page: number,
): Promise<ReleasesPage> {
  const res = await fetchApi(
    GLAB,
    projectApiUrl(ctx.project, releasesSuffix(page), ctx.host),
    { headers: apiHeaders() },
    ctx.withCliFallback,
  );
  if (!res) return { tag: ctx.viaCli() };
  if (!res.ok) return { tag: await releasesPageFailed(ctx, res.status) };
  return { releases: (await res.json()) as Release[] };
}

async function resolveRecentReleaseViaApi(
  ctx: ReleaseContext,
): Promise<string> {
  const result = await releasesPageViaApi(ctx, 1);
  if ('tag' in result) return result.tag;
  if (result.releases.length) return result.releases[0].tag_name;
  return resolveRef(ctx.project, '$recent', ctx.host, ctx.transports);
}

async function resolvePatternReleaseViaApi(
  ctx: ReleaseContext,
  pattern: RegExp,
): Promise<string> {
  for (let page = 1; ; page++) {
    const result = await releasesPageViaApi(ctx, page);
    if ('tag' in result) return result.tag;
    const found = result.releases.find((r) => pattern.test(r.tag_name));
    if (found) return found.tag_name;
    if (result.releases.length < PER_PAGE) break;
  }
  throw noMatchingReleasesError(ctx.release, ctx.project);
}

// $latest: use GitLab's releases/latest endpoint
async function resolveLatestReleaseViaApi(
  ctx: ReleaseContext,
): Promise<string> {
  const { project, host, transports, withCliFallback } = ctx;
  const res = await fetchApi(
    GLAB,
    projectApiUrl(project, 'releases/latest', host),
    { headers: apiHeaders() },
    withCliFallback,
  );
  if (!res) return ctx.viaCli();
  if (res.ok) {
    const rel = (await res.json()) as Release;
    // $latest must be a stable semver tag; if not, fall through to semver tag scan
    if (SEMVER_PATTERN.test(rel.tag_name)) return rel.tag_name;
  }
  // Releases endpoint unavailable (older GitLab) or non-semver latest — fall back to tags
  const unavailable = isReleasesUnavailable(res.status);
  if (!res.ok && !unavailable) {
    if (statusFallback(GLAB, res.status, withCliFallback)) return ctx.viaCli();
    throw new Error(
      `Failed to resolve $latest release for ${project}: HTTP ${res.status}`,
    );
  }
  if (unavailable && canUseCli(GLAB, withCliFallback)) return ctx.viaCli();
  // Fallback to semver tag scan (also handles non-semver releases/latest)
  return resolveRef(project, '$latest', host, transports);
}

export async function resolveReleaseTag(
  project: string,
  release: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  const pattern = parseRefPattern(release);
  if (!isLatestSentinel(release) && !isRecentSentinel(release) && !pattern) {
    return release;
  }

  verbose(`gitlab: resolving "${release}" release for ${project}`);

  const viaCli = () => resolveReleaseTagViaCli(project, release, host);
  return withTransports(transports, viaCli, (withCliFallback) => {
    const ctx: ReleaseContext = {
      project,
      release,
      host,
      transports,
      withCliFallback,
      viaCli,
    };
    if (isRecentSentinel(release)) return resolveRecentReleaseViaApi(ctx);
    if (pattern) return resolvePatternReleaseViaApi(ctx, pattern);
    return resolveLatestReleaseViaApi(ctx);
  });
}
