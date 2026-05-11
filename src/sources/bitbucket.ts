import * as path from 'path';
import { fetchWithRetry } from '../fetch';

export interface BitbucketResult {
  files: Map<string, string>;
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
  const token = process.env.BITBUCKET_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  const user = process.env.BITBUCKET_USERNAME;
  const pass = process.env.BITBUCKET_APP_PASSWORD;
  if (user && pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return headers;
}

async function resolveRef(
  workspace: string,
  repo: string,
  ref: string | undefined,
  host?: string,
): Promise<string> {
  if (ref && ref !== '$latest') return ref;

  if (ref === '$latest') {
    const tagsRes = await fetchWithRetry(
      `${getApiBase(host)}/repositories/${workspace}/${repo}/refs/tags?sort=-name&pagelen=1`,
      { headers: apiHeaders() },
    );
    if (tagsRes.ok) {
      const data = (await tagsRes.json()) as {
        values: Array<{ name: string }>;
      };
      if (data.values.length > 0) return data.values[0].name;
    }
  }

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

// Returns file content, or null if the path is a directory.
async function fetchFileOrDetect(
  workspace: string,
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<string | null> {
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
  return res.text();
}

async function fetchFile(
  workspace: string,
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<string> {
  const res = await fetchWithRetry(
    `${getApiBase(host)}/repositories/${workspace}/${repo}/src/${encodeURIComponent(ref)}/${filePath}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${filePath} from ${workspace}/${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  return res.text();
}

async function listDir(
  workspace: string,
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
): Promise<string[]> {
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
      async (p) =>
        [
          path.relative(normalizedPath, p),
          await fetchFile(workspace, repo, p, resolvedRef, host),
        ] as const,
    ),
  );
  return { files: new Map(entries) };
}
