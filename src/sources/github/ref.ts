import { verbose } from '../../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  maxSemverTag,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../../ref';
import type { Via } from '../../types';
import {
  apiOrCli,
  fetchApi,
  statusFallback,
  withTransports,
} from '../forge/transport';
import {
  apiGet,
  apiHeaders,
  getApiBase,
  GH,
  ghApi,
  ghRun,
  githubHttpError,
} from './client';

const TAGS_PER_PAGE = 100;

interface ResolveContext {
  repo: string;
  ref: string;
  host?: string;
  withCliFallback: boolean;
  viaCli: () => string;
}

function ghFailure(res: ReturnType<typeof ghRun>): string {
  return res.stderr.trim() || 'gh exited with status ' + res.status;
}

/** Yields the tag names of a repository, one API page at a time. */
async function* tagPagesApi(
  repo: string,
  host?: string,
): AsyncGenerator<string[]> {
  for (let page = 1; ; page++) {
    const res = await apiGet(
      host,
      `repos/${repo}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`,
    );
    if (!res.ok) {
      throw await githubHttpError(res, `Failed to list tags for ${repo}`);
    }
    const tags = (await res.json()) as Array<{ name: string }>;
    yield tags.map((t) => t.name);
    if (tags.length < TAGS_PER_PAGE) return;
  }
}

async function findHighestSemverTagApi(
  repo: string,
  host?: string,
): Promise<string | null> {
  let best: string | null = null;
  for await (const names of tagPagesApi(repo, host)) {
    const candidate = maxSemverTag(names);
    if (candidate && (!best || maxSemverTag([best, candidate]) === candidate))
      best = candidate;
  }
  return best;
}

async function findTagMatchingPatternApi(
  repo: string,
  pattern: RegExp,
  host?: string,
): Promise<string | null> {
  for await (const names of tagPagesApi(repo, host)) {
    const found = names.find((n) => pattern.test(n));
    if (found !== undefined) return found;
  }
  return null;
}

function listTagNamesCli(repo: string, host?: string): string[] {
  const res = ghApi(`repos/${repo}/tags`, '.[].name', host, 'gh', [
    '--paginate',
  ]);
  if (res.status !== 0)
    throw new Error(`Failed to list tags for ${repo}: ${ghFailure(res)}`);
  return res.stdout.trim().split('\n').filter(Boolean);
}

function noSemverTagsError(repo: string): Error {
  return new Error(
    `No semver tags found for ${repo} (needed to resolve $latest)`,
  );
}

function noPatternMatchError(ref: string, repo: string): Error {
  return new Error(`No tags matching "${ref}" found for ${repo}`);
}

function noTagsError(repo: string): Error {
  return new Error(`No tags found for ${repo} (needed to resolve $recent)`);
}

// Pattern: paginate tags and return first match
function resolvePatternViaApi(
  ctx: ResolveContext,
  pattern: RegExp,
): Promise<string> {
  const { repo, ref, host } = ctx;
  return apiOrCli(
    GH,
    ctx.withCliFallback,
    async () => {
      const found = await findTagMatchingPatternApi(repo, pattern, host);
      if (found !== null) return found;
      throw noPatternMatchError(ref, repo);
    },
    ctx.viaCli,
  );
}

// $latest: try releases/latest first (semantic "latest stable release"), then scan semver tags
async function resolveLatestViaApi(ctx: ResolveContext): Promise<string> {
  const { repo, ref, host, withCliFallback } = ctx;
  const relRes = await fetchApi(
    GH,
    `${getApiBase(host)}/repos/${repo}/releases/latest`,
    { headers: apiHeaders() },
    withCliFallback,
  );
  if (!relRes) return ctx.viaCli();
  if (relRes.ok) {
    const rel = (await relRes.json()) as { tag_name: string };
    if (SEMVER_PATTERN.test(rel.tag_name)) return rel.tag_name;
    // non-semver release tag: fall through to tag scan
  } else if (relRes.status !== 404) {
    if (statusFallback(GH, relRes.status, withCliFallback)) return ctx.viaCli();
    throw await githubHttpError(
      relRes,
      `Failed to resolve "${ref}" for ${repo}`,
    );
  }
  return apiOrCli(
    GH,
    withCliFallback,
    async () => {
      const found = await findHighestSemverTagApi(repo, host);
      if (found !== null) return found;
      throw noSemverTagsError(repo);
    },
    ctx.viaCli,
  );
}

// $recent: most recently created tag (not releases/latest, which reflects publication order)
async function resolveRecentViaApi(ctx: ResolveContext): Promise<string> {
  const { repo, ref, host, withCliFallback } = ctx;
  const tagRes = await fetchApi(
    GH,
    `${getApiBase(host)}/repos/${repo}/tags?per_page=1`,
    { headers: apiHeaders() },
    withCliFallback,
  );
  if (!tagRes) return ctx.viaCli();
  if (tagRes.ok) {
    const tags = (await tagRes.json()) as Array<{ name: string }>;
    if (tags.length) return tags[0].name;
    throw noTagsError(repo);
  }
  if (statusFallback(GH, tagRes.status, withCliFallback)) return ctx.viaCli();
  throw await githubHttpError(tagRes, `Failed to resolve "${ref}" for ${repo}`);
}

export async function resolveRef(
  repo: string,
  ref: string | undefined,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  if (!ref) return 'HEAD';
  const pattern = parseRefPattern(ref);
  if (!isLatestSentinel(ref) && !isRecentSentinel(ref) && !pattern) return ref;

  verbose(`github: resolving "${ref}" for ${repo}`);

  const viaCli = () => resolveRefViaCli(repo, ref, host);
  return withTransports(transports, viaCli, (withCliFallback) => {
    const ctx: ResolveContext = { repo, ref, host, withCliFallback, viaCli };
    if (pattern) return resolvePatternViaApi(ctx, pattern);
    if (isLatestSentinel(ref)) return resolveLatestViaApi(ctx);
    return resolveRecentViaApi(ctx);
  });
}

// $latest: try releases/latest first, then scan semver tags
function resolveLatestViaCli(repo: string, host?: string): string {
  const res = ghApi(
    `repos/${repo}/releases/latest`,
    '.tag_name',
    host,
    'gh fallback',
  );
  const tag = res.stdout.trim();
  if (res.status === 0 && tag && SEMVER_PATTERN.test(tag)) return tag;
  // non-semver release: fall through to tag search
  const found = maxSemverTag(listTagNamesCli(repo, host));
  if (found !== null) return found;
  throw noSemverTagsError(repo);
}

// $recent: most recently created tag (not releases/latest, which reflects publication order)
function resolveRecentViaCli(repo: string, host?: string): string {
  const tagRes = ghApi(
    `repos/${repo}/tags?per_page=1`,
    '.[0].name',
    host,
    'gh fallback',
  );
  if (tagRes.status !== 0)
    throw new Error(`Failed to list tags for ${repo}: ${ghFailure(tagRes)}`);
  const tagName = tagRes.stdout.trim();
  if (!tagName || tagName === 'null') throw noTagsError(repo);
  return tagName;
}

function resolveRefViaCli(repo: string, ref: string, host?: string): string {
  const pattern = parseRefPattern(ref);

  if (pattern) {
    const found = listTagNamesCli(repo, host).find((n) => pattern.test(n));
    if (found !== undefined) return found;
    throw noPatternMatchError(ref, repo);
  }

  if (isLatestSentinel(ref)) return resolveLatestViaCli(repo, host);
  return resolveRecentViaCli(repo, host);
}
