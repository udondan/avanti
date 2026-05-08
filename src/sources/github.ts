import { spawnSync } from 'child_process';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';

export interface GitHubResult {
  files: Map<string, string>;
}

function getApiBase(): string {
  const host = process.env.GITHUB_HOST;
  return host ? `https://${host}/api/v3` : 'https://api.github.com';
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'scync',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isGhAvailable(): boolean {
  return !spawnSync('gh', ['--version'], { encoding: 'utf8' }).error;
}

function ghRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`gh error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

async function detectPathType(
  repo: string,
  filePath: string,
  ref: string,
): Promise<'file' | 'directory'> {
  const res = await fetchWithRetry(
    `${getApiBase()}/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders() },
  );
  if (res.ok) {
    const data = await res.json();
    return Array.isArray(data) ? 'directory' : 'file';
  }
  if (shouldFallback(res.status) && isGhAvailable()) {
    return detectPathTypeViaCli(repo, filePath, ref);
  }
  throw new Error(
    `Failed to stat ${filePath} in ${repo}@${ref}: HTTP ${res.status}`,
  );
}

function detectPathTypeViaCli(
  repo: string,
  filePath: string,
  ref: string,
): 'file' | 'directory' {
  const res = ghRun([
    'api',
    `repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    '--jq',
    'if type == "array" then "directory" else "file" end',
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Failed to stat ${filePath} in ${repo}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout.trim() as 'file' | 'directory';
}

async function fetchFile(
  repo: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const res = await fetchWithRetry(
    `${getApiBase()}/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    if (shouldFallback(res.status) && isGhAvailable()) {
      return fetchFileViaCli(repo, filePath, ref);
    }
    throw new Error(
      `Failed to fetch ${filePath} from ${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as { content: string };
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString(
    'utf8',
  );
}

function fetchFileViaCli(repo: string, filePath: string, ref: string): string {
  const res = ghRun([
    'api',
    `repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    '--jq',
    '.content',
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Failed to fetch ${filePath} from ${repo}@${ref}: ${res.stderr}`,
    );
  }
  const b64 = res.stdout.trim().replace(/\\n/g, '').replace(/\n/g, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function listTree(
  repo: string,
  dirPath: string,
  ref: string,
): Promise<string[]> {
  const res = await fetchWithRetry(
    `${getApiBase()}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    if (shouldFallback(res.status) && isGhAvailable()) {
      return listTreeViaCli(repo, dirPath, ref);
    }
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    tree: Array<{ type: string; path: string }>;
  };
  const prefix = `${dirPath}/`;
  return data.tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
    .map((item) => item.path);
}

function listTreeViaCli(repo: string, dirPath: string, ref: string): string[] {
  const res = ghRun([
    'api',
    `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    '--arg',
    'dirPath',
    dirPath,
    '--jq',
    '.tree[] | select(.type == "blob") | select(.path | startswith($dirPath + "/")) | .path',
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout.trim().split('\n').filter(Boolean);
}

async function resolveRef(
  repo: string,
  ref: string | undefined,
): Promise<string> {
  if (ref !== '$latest') return ref ?? 'HEAD';

  // Try latest release first
  const relRes = await fetchWithRetry(
    `${getApiBase()}/repos/${repo}/releases/latest`,
    {
      headers: apiHeaders(),
    },
  );
  if (relRes.ok) {
    const rel = (await relRes.json()) as { tag_name: string };
    return rel.tag_name;
  }
  // No releases (404) — fall back to most recent tag
  if (relRes.status === 404) {
    const tagRes = await fetchWithRetry(
      `${getApiBase()}/repos/${repo}/tags?per_page=1`,
      { headers: apiHeaders() },
    );
    if (tagRes.ok) {
      const tags = (await tagRes.json()) as Array<{ name: string }>;
      if (tags.length) return tags[0].name;
      throw new Error(`No releases or tags found for ${repo}`);
    }
    if (shouldFallback(tagRes.status) && isGhAvailable()) {
      return resolveRefViaCli(repo);
    }
    throw new Error(
      `Failed to resolve $latest for ${repo}: HTTP ${tagRes.status}`,
    );
  }
  if (shouldFallback(relRes.status) && isGhAvailable()) {
    return resolveRefViaCli(repo);
  }
  throw new Error(
    `Failed to resolve $latest for ${repo}: HTTP ${relRes.status}`,
  );
}

function resolveRefViaCli(repo: string): string {
  const res = ghRun([
    'api',
    `repos/${repo}/releases/latest`,
    '--jq',
    '.tag_name',
  ]);
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  // Fall back to most recent tag
  const tagRes = ghRun([
    'api',
    `repos/${repo}/tags?per_page=1`,
    '--jq',
    '.[0].name',
  ]);
  if (tagRes.status !== 0 || !tagRes.stdout.trim()) {
    throw new Error(`No releases or tags found for ${repo}`);
  }
  return tagRes.stdout.trim();
}

export async function fetchGitHub(
  repo: string,
  file: string,
  ref: string | undefined,
): Promise<GitHubResult> {
  const resolvedRef = await resolveRef(repo, ref);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    (await detectPathType(repo, normalizedPath, resolvedRef)) === 'directory';

  if (!isDirectory) {
    const content = await fetchFile(repo, normalizedPath, resolvedRef);
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  const paths = await listTree(repo, normalizedPath, resolvedRef);
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${repo}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const entries = await Promise.all(
    paths.map(
      async (p) =>
        [
          path.relative(normalizedPath, p),
          await fetchFile(repo, p, resolvedRef),
        ] as const,
    ),
  );
  return { files: new Map(entries) };
}
