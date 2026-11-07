import { isRecentSentinel, parseRefPattern, SEMVER_PATTERN } from '../../ref';
import {
  firstTagViaCli,
  glabApi,
  glabFailure,
  PER_PAGE,
  projectEndpoint,
} from './client';

export type Release = { tag_name: string };

export function noMatchingReleasesError(
  release: string,
  project: string,
): Error {
  return new Error(`No releases matching "${release}" found for ${project}`);
}

export function releasesSuffix(page: number): string {
  return `releases?order_by=released_at&sort=desc&per_page=${PER_PAGE}&page=${page}`;
}

/** Parses a glab releases page; null for empty output or an unexpected payload. */
function parseReleasesPage(stdout: string): Release[] | null {
  if (!stdout.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  // An unexpected payload is treated like invalid JSON.
  return Array.isArray(parsed) ? (parsed as Release[]) : null;
}

/** Yields pages of releases (sorted by released_at desc) via glab. */
function* releasePagesCli(
  project: string,
  host?: string,
): Generator<Release[]> {
  for (let page = 1; ; page++) {
    const res = glabApi(projectEndpoint(project, releasesSuffix(page)), host);
    if (res.status !== 0)
      throw new Error(
        `Failed to list releases for ${project}: ${glabFailure(res)}`,
      );
    const releases = parseReleasesPage(res.stdout);
    if (!releases) return;
    yield releases;
    if (releases.length < PER_PAGE) return;
  }
}

function resolveRecentReleaseViaCli(
  project: string,
  release: string,
  host?: string,
): string {
  const first = releasePagesCli(project, host).next();
  if (!first.done && first.value.length) return first.value[0].tag_name;
  // $recent with no releases: fall back to tags
  return firstTagViaCli(
    project,
    host,
    'updated',
    `Failed to resolve "${release}" release for ${project}`,
    `No releases or tags found for ${project} (needed to resolve ${release})`,
  );
}

function parseSemverReleaseTag(stdout: string): string | undefined {
  try {
    const rel = JSON.parse(stdout) as Release;
    // $latest must be a stable semver tag; if not, fall through to semver tag scan
    if (rel.tag_name && SEMVER_PATTERN.test(rel.tag_name)) return rel.tag_name;
  } catch {
    // fall through to tags
  }
  return undefined;
}

function resolveLatestReleaseViaCli(project: string, host?: string): string {
  const res = glabApi(projectEndpoint(project, 'releases/latest'), host);
  const tag =
    res.status === 0 && res.stdout.trim()
      ? parseSemverReleaseTag(res.stdout)
      : undefined;
  if (tag) return tag;
  // Fall back to semver tag scan (also handles non-semver releases/latest)
  return firstTagViaCli(
    project,
    host,
    'version',
    `Failed to resolve $latest release for ${project}`,
    `No releases or tags found for ${project} (needed to resolve $latest)`,
  );
}

export function resolveReleaseTagViaCli(
  project: string,
  release: string,
  host?: string,
): string {
  const pattern = parseRefPattern(release);

  if (pattern) {
    for (const releases of releasePagesCli(project, host)) {
      const found = releases.find((r) => pattern.test(r.tag_name));
      if (found) return found.tag_name;
    }
    throw noMatchingReleasesError(release, project);
  }

  if (isRecentSentinel(release)) {
    return resolveRecentReleaseViaCli(project, release, host);
  }
  return resolveLatestReleaseViaCli(project, host);
}
