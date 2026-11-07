import { posix as path } from 'path';
import {
  DIRECTORY_FETCH_CONCURRENCY,
  mapWithConcurrency,
} from '../concurrency';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  maxSemverTag,
  parseRefPattern,
} from '../ref';

interface BitbucketResult {
  files: Map<string, Buffer>;
}

function getApiBase(override?: string): string {
  // First non-empty (after trimming) of override and $BITBUCKET_HOST.
  const host =
    [override, process.env.BITBUCKET_HOST]
      .map((v) => v?.trim())
      .find(Boolean) ?? 'api.bitbucket.org';
  return `https://${host}/2.0`;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'avanti' };
  const token = process.env.BITBUCKET_TOKEN?.trim();
  const email = process.env.BITBUCKET_EMAIL?.trim();
  if (token && email) {
    // Atlassian API token (created in Atlassian account settings): Basic auth with email:token
    const credentials = Buffer.from(`${email}:${token}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
    return headers;
  }
  if (token) {
    // Workspace/Repository Access Token: Bearer auth
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface RepoCoords {
  workspace: string;
  repo: string;
  host?: string;
}

interface TagPage {
  values: Array<{ name: string }>;
  next?: string;
}

function repoUrl(r: RepoCoords): string {
  return `${getApiBase(r.host)}/repositories/${r.workspace}/${r.repo}`;
}

async function getTagPage(r: RepoCoords, url: string): Promise<TagPage> {
  const res = await fetchWithRetry(url, { headers: apiHeaders() });
  if (!res.ok)
    throw new Error(
      `Failed to list tags for ${r.workspace}/${r.repo}: HTTP ${res.status}`,
    );
  return (await res.json()) as TagPage;
}

// Walks the paginated tag list until `visit` returns a tag name.
async function findInTagPages(
  r: RepoCoords,
  query: string,
  visit: (names: string[]) => string | undefined,
): Promise<string | undefined> {
  let url: string | null = `${repoUrl(r)}/refs/tags?${query}`;
  while (url) {
    const page = await getTagPage(r, url);
    const found = visit(page.values.map((t) => t.name));
    if (found !== undefined) return found;
    url = page.next ?? null;
  }
  return undefined;
}

// No ref: return default branch
async function resolveDefaultBranch(r: RepoCoords): Promise<string> {
  const repoRes = await fetchWithRetry(repoUrl(r), { headers: apiHeaders() });
  if (!repoRes.ok) {
    throw new Error(
      `Failed to resolve ref for ${r.workspace}/${r.repo}: HTTP ${repoRes.status}`,
    );
  }
  const repoData = (await repoRes.json()) as {
    mainbranch?: { name: string };
  };
  return repoData.mainbranch?.name ?? 'main';
}

function higherSemver(best: string | null, candidate: string | null) {
  return candidate && (!best || maxSemverTag([best, candidate]) === candidate)
    ? candidate
    : best;
}

// $latest: paginate tags and track the highest semver incrementally
async function resolveLatestTag(r: RepoCoords): Promise<string> {
  const state = { best: null as string | null };
  await findInTagPages(r, 'sort=-name&pagelen=100', (names) => {
    state.best = higherSemver(state.best, maxSemverTag(names));
    return undefined;
  });
  if (state.best) return state.best;
  throw new Error(
    `No semver tags found for ${r.workspace}/${r.repo} (needed to resolve $latest)`,
  );
}

// $recent: most recently committed tag (sort by target commit date)
async function resolveRecentTag(r: RepoCoords): Promise<string> {
  const tagsRes = await fetchWithRetry(
    `${repoUrl(r)}/refs/tags?sort=-target.date&pagelen=1`,
    { headers: apiHeaders() },
  );
  if (!tagsRes.ok)
    throw new Error(
      `Failed to resolve $recent for ${r.workspace}/${r.repo}: HTTP ${tagsRes.status}`,
    );
  const data = (await tagsRes.json()) as TagPage;
  if (data.values.length > 0) return data.values[0].name;
  throw new Error(
    `No tags found for ${r.workspace}/${r.repo} (needed to resolve $recent)`,
  );
}

// Pattern: paginate tags sorted by target date, short-circuit on first match
async function resolvePatternTag(
  r: RepoCoords,
  ref: string,
  pattern: RegExp,
): Promise<string> {
  const found = await findInTagPages(
    r,
    'sort=-target.date&pagelen=100',
    (names) => names.find((n) => pattern.test(n)),
  );
  if (found !== undefined) return found;
  throw new Error(
    `No tags matching "${ref}" found for ${r.workspace}/${r.repo}`,
  );
}

async function resolveRef(
  workspace: string,
  repo: string,
  ref: string | undefined,
  host?: string,
): Promise<string> {
  const r: RepoCoords = { workspace, repo, host };
  if (!ref) return resolveDefaultBranch(r);
  if (isLatestSentinel(ref)) return resolveLatestTag(r);
  if (isRecentSentinel(ref)) return resolveRecentTag(r);
  const pattern = parseRefPattern(ref);
  return pattern ? resolvePatternTag(r, ref, pattern) : ref;
}

// Returns file content, or null if the path is a directory.
async function fetchFileOrDetect(
  workspace: string,
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<Buffer | null> {
  verbose(`bitbucket: fetching ${workspace}/${repo}:${filePath}@${ref}`);
  const res = await fetchWithRetry(
    `${getApiBase(host)}/repositories/${workspace}/${repo}/src/${encodeURIComponent(ref)}/${filePath}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${filePath} from ${workspace}/${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFile(
  workspace: string,
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<Buffer> {
  const res = await fetchWithRetry(
    `${getApiBase(host)}/repositories/${workspace}/${repo}/src/${encodeURIComponent(ref)}/${filePath}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${filePath} from ${workspace}/${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

async function listDir(
  workspace: string,
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
): Promise<string[]> {
  verbose(
    `bitbucket: listing directory ${workspace}/${repo}:${dirPath}@${ref}`,
  );
  const files: string[] = [];
  let url: string | null =
    `${getApiBase(host)}/repositories/${workspace}/${repo}/src/${encodeURIComponent(ref)}/${dirPath}/?pagelen=100`;

  while (url) {
    const res = await fetchWithRetry(url, { headers: apiHeaders() });
    if (!res.ok) {
      throw new Error(
        `Failed to list ${dirPath} in ${workspace}/${repo}@${ref}: HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as {
      values: Array<{ type: string; path: string }>;
      next?: string;
    };
    for (const item of data.values) {
      if (item.type === 'commit_file') {
        files.push(item.path);
      } else if (item.type === 'commit_directory') {
        const sub = await listDir(workspace, repo, item.path, ref, host);
        files.push(...sub);
      }
    }
    url = data.next ?? null;
  }

  return files;
}

export async function fetchBitbucket(
  workspace: string,
  repo: string,
  file: string,
  ref: string | undefined,
  host?: string,
): Promise<BitbucketResult> {
  const resolvedRef = await resolveRef(workspace, repo, ref, host);
  const normalizedPath = file.replace(/\/$/, '');

  if (!file.endsWith('/')) {
    const content = await fetchFileOrDetect(
      workspace,
      repo,
      normalizedPath,
      resolvedRef,
      host,
    );
    if (content !== null) {
      return {
        files: new Map([[path.basename(normalizedPath), content]]),
      };
    }
  }

  const paths = await listDir(
    workspace,
    repo,
    normalizedPath,
    resolvedRef,
    host,
  );
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${workspace}/${repo}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const entries = await mapWithConcurrency(
    paths,
    DIRECTORY_FETCH_CONCURRENCY,
    async (p): Promise<[string, Buffer]> => [
      path.relative(normalizedPath, p),
      await fetchFile(workspace, repo, p, resolvedRef, host),
    ],
  );
  return { files: new Map(entries) };
}
