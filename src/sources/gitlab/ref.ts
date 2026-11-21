import { fetchWithRetry } from '../../fetch';
import { verbose } from '../../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../../ref';
import type { Via } from '../../types';
import {
  apiOrCli,
  fetchApi,
  HttpError,
  statusFallback,
  withTransports,
} from '../forge/transport';
import {
  apiHeaders,
  firstTagViaCli,
  GLAB,
  glabApi,
  glabFailure,
  PER_PAGE,
  projectApiUrl,
  projectEndpoint,
} from './client';

type TagSort = 'updated' | 'version';
type Tag = { name: string };

function tagsSuffix(sortBy: TagSort, page: number): string {
  return `repository/tags?order_by=${sortBy}&sort=desc&per_page=${PER_PAGE}&page=${page}`;
}

/** Yields pages of tags via the REST API until a short page is returned. */
async function* tagPagesApi(
  project: string,
  sortBy: TagSort,
  host?: string,
): AsyncGenerator<Tag[]> {
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(
      projectApiUrl(project, tagsSuffix(sortBy, page), host),
      { headers: apiHeaders() },
    );
    if (!res.ok)
      throw new HttpError(
        res.status,
        `Failed to list tags for ${project}: HTTP ${res.status}`,
      );
    const tags = (await res.json()) as Tag[];
    yield tags;
    if (tags.length < PER_PAGE) return;
  }
}

/** Yields pages of tags via glab until an empty or short page is returned. */
function* tagPagesCli(
  project: string,
  sortBy: TagSort,
  host?: string,
): Generator<Tag[]> {
  for (let page = 1; ; page++) {
    const res = glabApi(
      projectEndpoint(project, tagsSuffix(sortBy, page)),
      host,
    );
    if (res.status !== 0)
      throw new Error(
        `Failed to list tags for ${project}: ${glabFailure(res)}`,
      );
    if (!res.stdout.trim()) return;
    const tags = JSON.parse(res.stdout) as Tag[];
    yield tags;
    if (tags.length < PER_PAGE) return;
  }
}

async function findTagApi(
  project: string,
  pattern: RegExp,
  sortBy: TagSort,
  host?: string,
): Promise<string | null> {
  for await (const tags of tagPagesApi(project, sortBy, host)) {
    const found = tags.find((t) => pattern.test(t.name));
    if (found) return found.name;
  }
  return null;
}

function findTagCli(
  project: string,
  pattern: RegExp,
  sortBy: TagSort,
  host?: string,
): string | null {
  for (const tags of tagPagesCli(project, sortBy, host)) {
    const found = tags.find((t) => pattern.test(t.name));
    if (found) return found.name;
  }
  return null;
}

function noRecentTagsError(project: string): Error {
  return new Error(`No tags found for ${project} (needed to resolve $recent)`);
}

/**
 * Pattern refs scan tags sorted by most-recently-updated; `$latest` scans
 * semver-sorted tags (GitLab's version ordering is semver-aware), filtered by
 * SEMVER_PATTERN to skip non-semver tags that sort first.
 */
function tagSearch(
  project: string,
  ref: string,
  pattern: RegExp | null,
): { pattern: RegExp; sortBy: TagSort; notFound: () => Error } {
  if (pattern) {
    return {
      pattern,
      sortBy: 'updated',
      notFound: () =>
        new Error(`No tags matching "${ref}" found for ${project}`),
    };
  }
  return {
    pattern: SEMVER_PATTERN,
    sortBy: 'version',
    notFound: () =>
      new Error(
        `No semver tags found for ${project} (needed to resolve $latest)`,
      ),
  };
}

// $recent: most-recently-updated tag (no semver filter)
async function resolveRecentViaApi(
  project: string,
  host: string | undefined,
  withCliFallback: boolean,
  viaCli: () => string,
): Promise<string> {
  const res = await fetchApi(
    GLAB,
    projectApiUrl(
      project,
      'repository/tags?order_by=updated&sort=desc&per_page=1',
      host,
    ),
    { headers: apiHeaders() },
    withCliFallback,
  );
  if (!res) return viaCli();
  if (!res.ok) {
    if (statusFallback(GLAB, res.status, withCliFallback)) return viaCli();
    throw new Error(
      `Failed to resolve $recent for ${project}: HTTP ${res.status}`,
    );
  }
  const tags = (await res.json()) as Tag[];
  if (!tags.length) throw noRecentTagsError(project);
  return tags[0].name;
}

export async function resolveRef(
  project: string,
  ref: string | undefined,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  if (ref === undefined || ref === '') return 'HEAD';
  const pattern = parseRefPattern(ref);
  if (!isLatestSentinel(ref) && !isRecentSentinel(ref) && !pattern) return ref;

  verbose(`gitlab: resolving "${ref}" for ${project}`);

  const viaCli = () => resolveRefViaCli(project, ref, host);
  return withTransports(transports, viaCli, (withCliFallback) => {
    if (isRecentSentinel(ref)) {
      return resolveRecentViaApi(project, host, withCliFallback, viaCli);
    }
    const search = tagSearch(project, ref, pattern);
    return apiOrCli(
      GLAB,
      withCliFallback,
      async () => {
        const found = await findTagApi(
          project,
          search.pattern,
          search.sortBy,
          host,
        );
        if (found !== null) return found;
        throw search.notFound();
      },
      viaCli,
    );
  });
}

function resolveRefViaCli(project: string, ref: string, host?: string): string {
  const pattern = parseRefPattern(ref);

  if (isRecentSentinel(ref)) {
    return firstTagViaCli(
      project,
      host,
      'updated',
      `Failed to resolve $recent for ${project}`,
      noRecentTagsError(project).message,
    );
  }

  const search = tagSearch(project, ref, pattern);
  const found = findTagCli(project, search.pattern, search.sortBy, host);
  if (found !== null) return found;
  throw search.notFound();
}
