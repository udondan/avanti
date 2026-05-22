import { posix as path } from 'path';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  maxSemverTag,
  parseRefPattern,
} from '../ref';

export interface BitbucketResult {
  files: Map<string, Buffer>;
}

function getApiBase(override?: string): string {
  const host =
    override?.trim() ||
    process.env.BITBUCKET_HOST?.trim() ||
    'api.bitbucket.org';
  return `https://${host}/2.0`;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'avanti' };
  const token = process.env.BITBUCKET_TOKEN?.trim();
  const email = process.env.BITBUCKET_EMAIL?.trim();
  if (token && email) {
    // Atlassian API token (created in Atlassian account settings): Basic auth with email:token
    headers.Authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    return headers;
  }
  if (token) {
    // Workspace/Repository Access Token: Bearer auth
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function listBitbucketTagsAll(
  workspace: string,
  repo: string,
  sort: string,
  host?: string,
): Promise<string[]> {
  const all: string[] = [];
  let url: string | null =
    `${getApiBase(host)}/repositories/${workspace}/${repo}/refs/tags?sort=${sort}&pagelen=100`;
  while (url) {
    const res = await fetchWithRetry(url, { headers: apiHeaders() });
    if (!res.ok)
      throw new Error(
        `Failed to list tags for ${workspace}/${repo}: HTTP ${res.status}`,
      );
    const data = (await res.json()) as {
      values: Array<{ name: string }>;
      next?: string;
    };
    all.push(...data.values.map((t) => t.name));
    url = data.next ?? null;
  }
  return all;
}

async function resolveRef(
  workspace: string,
  repo: string,
  ref: string | undefined,
  host?: string,
): Promise<string> {
  const pattern = ref ? parseRefPattern(ref) : null;
  if (!isLatestSentinel(ref) && !isRecentSentinel(ref) && !pattern && ref) {
    return ref;
  }

  if (!ref) {
    // No ref: return default branch
    const repoRes = await fetchWithRetry(
      `${getApiBase(host)}/repositories/${workspace}/${repo}`,
      { headers: apiHeaders() },
    );
    if (!repoRes.ok) {
      throw new Error(
        `Failed to resolve ref for ${workspace}/${repo}: HTTP ${repoRes.status}`,
      );
    }
    const repoData = (await repoRes.json()) as {
      mainbranch?: { name: string };
    };
    return repoData.mainbranch?.name ?? 'main';
  }

  // $latest: collect all tags, pick the highest semver
  if (isLatestSentinel(ref)) {
    const tags = await listBitbucketTagsAll(workspace, repo, '-name', host);
    const found = maxSemverTag(tags);
    if (found) return found;
    throw new Error(
      `No semver tags found for ${workspace}/${repo} (needed to resolve $latest)`,
    );
  }

  // $recent: most recently committed tag (sort by target commit date)
  if (isRecentSentinel(ref)) {
    const tagsRes = await fetchWithRetry(
      `${getApiBase(host)}/repositories/${workspace}/${repo}/refs/tags?sort=-target.date&pagelen=1`,
      { headers: apiHeaders() },
    );
    if (!tagsRes.ok)
      throw new Error(
        `Failed to resolve $recent for ${workspace}/${repo}: HTTP ${tagsRes.status}`,
      );
    const data = (await tagsRes.json()) as { values: Array<{ name: string }> };
    if (data.values.length > 0) return data.values[0].name;
    throw new Error(
      `No tags found for ${workspace}/${repo} (needed to resolve $recent)`,
    );
  }

  // Pattern: paginate tags sorted by target date, filter by regex
  const tags = await listBitbucketTagsAll(
    workspace,
    repo,
    '-target.date',
    host,
  );
  const found = tags.find((n) => pattern!.test(n)) ?? null;
  if (found) return found;
  throw new Error(`No tags matching "${ref}" found for ${workspace}/${repo}`);
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
  const entries = await Promise.all(
    paths.map(
      async (p): Promise<[string, Buffer]> => [
        path.relative(normalizedPath, p),
        await fetchFile(workspace, repo, p, resolvedRef, host),
      ],
    ),
  );
  return { files: new Map(entries) };
}
