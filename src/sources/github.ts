import { spawnSync } from 'child_process';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';
import type { Via } from '../types';

function normalizeVia(via?: Via | Via[]): Via[] {
  if (!via) return ['api', 'cli'];
  if (Array.isArray(via)) {
    if (via.length === 0) throw new Error('via: array must not be empty');
    return via;
  }
  return [via];
}

export interface GitHubResult {
  files: Map<string, Buffer>;
}

function getApiBase(override?: string): string {
  const host = override?.trim() || process.env.GITHUB_HOST?.trim() || '';
  return host ? `https://${host}/api/v3` : 'https://api.github.com';
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'avanti',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && e.message === 'fetch failed';
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

type PathInfo = { kind: 'file'; content: Buffer } | { kind: 'directory' };

function decodeBase64Content(b64: string): Buffer {
  return Buffer.from(b64.replace(/\n/g, ''), 'base64');
}

function hostnameArgs(host?: string): string[] {
  const resolved = host?.trim() || process.env.GITHUB_HOST?.trim() || '';
  return resolved ? ['--hostname', resolved] : [];
}

function encodeFilePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function fetchPathInfo(
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<PathInfo> {
  verbose(`github: fetching ${repo}:${filePath}@${ref}`);

  if (transports[0] === 'cli') {
    try {
      return fetchPathInfoViaCli(repo, filePath, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/contents/${encodeFilePath(filePath)}?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
      verbose(`github: HTTP fetch failed, falling back to gh`);
      return fetchPathInfoViaCli(repo, filePath, ref, host);
    }
    throw e;
  }
  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data)) return { kind: 'directory' };
    return {
      kind: 'file',
      content: decodeBase64Content((data as { content: string }).content),
    };
  }
  if (shouldFallback(res.status) && withCliFallback && isGhAvailable()) {
    return fetchPathInfoViaCli(repo, filePath, ref, host);
  }
  throw new Error(
    `Failed to fetch ${filePath} from ${repo}@${ref}: HTTP ${res.status}`,
  );
}

function fetchPathInfoViaCli(
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): PathInfo {
  const args = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/contents/${encodeFilePath(filePath)}?ref=${encodeURIComponent(ref)}`,
    '--jq',
    'if type == "array" then "directory" else .content end',
  ];
  verbose(`github: gh fallback: gh ${args.join(' ')}`);
  const res = ghRun(args);
  if (res.status !== 0) {
    throw new Error(
      `Failed to fetch ${filePath} from ${repo}@${ref}: ${res.stderr}`,
    );
  }
  const output = res.stdout.trim();
  if (output === 'directory') return { kind: 'directory' };
  return {
    kind: 'file',
    content: decodeBase64Content(output.replace(/\\n/g, '')),
  };
}

async function fetchFile(
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<Buffer> {
  const info = await fetchPathInfo(repo, filePath, ref, host, transports);
  if (info.kind !== 'file') {
    throw new Error(`Expected a file but got a directory: ${filePath}`);
  }
  return info.content;
}

async function listTree(
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string[]> {
  verbose(`github: listing tree ${repo}:${dirPath}@${ref}`);

  if (transports[0] === 'cli') {
    try {
      return listTreeViaCli(repo, dirPath, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
      verbose(`github: HTTP fetch failed, falling back to gh`);
      return listTreeViaCli(repo, dirPath, ref, host);
    }
    throw e;
  }
  if (!res.ok) {
    if (shouldFallback(res.status) && withCliFallback && isGhAvailable()) {
      return listTreeViaCli(repo, dirPath, ref, host);
    }
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    truncated: boolean;
    tree: Array<{ type: string; path: string }>;
  };
  if (data.truncated) {
    throw new Error(
      `Repository ${repo} exceeds the GitHub Trees API limit (100,000 entries). The directory listing for ${dirPath} is incomplete. Use a more specific path to reduce the result set.`,
    );
  }
  const prefix = `${dirPath}/`;
  return data.tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
    .map((item) => item.path);
}

function listTreeViaCli(
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
): string[] {
  const args = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    '--arg',
    'dirPath',
    dirPath,
    '--jq',
    'if .truncated then error("truncated") else .tree[] | select(.type == "blob") | select(.path | startswith($dirPath + "/")) | .path end',
  ];
  verbose(`github: gh fallback: gh ${args.join(' ')}`);
  const res = ghRun(args);
  if (res.status !== 0) {
    if (res.stderr.includes('truncated')) {
      throw new Error(
        `Repository ${repo} exceeds the GitHub Trees API limit (100,000 entries). The directory listing for ${dirPath} is incomplete. Use a more specific path to reduce the result set.`,
      );
    }
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout.trim().split('\n').filter(Boolean);
}

async function resolveRef(
  repo: string,
  ref: string | undefined,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  if (ref !== '$latest') return ref ?? 'HEAD';

  verbose(`github: resolving $latest for ${repo}`);

  if (transports[0] === 'cli') {
    try {
      return resolveRefViaCli(repo, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  // Try latest release first
  let relRes: Response;
  try {
    relRes = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/releases/latest`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
      verbose(`github: HTTP fetch failed, falling back to gh`);
      return resolveRefViaCli(repo, host);
    }
    throw e;
  }
  if (relRes.ok) {
    const rel = (await relRes.json()) as { tag_name: string };
    return rel.tag_name;
  }
  // No releases (404) — fall back to most recent tag
  if (relRes.status === 404) {
    let tagRes: Response;
    try {
      tagRes = await fetchWithRetry(
        `${getApiBase(host)}/repos/${repo}/tags?per_page=1`,
        { headers: apiHeaders() },
      );
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
        verbose(`github: HTTP fetch failed, falling back to gh`);
        return resolveRefViaCli(repo, host);
      }
      throw e;
    }
    if (tagRes.ok) {
      const tags = (await tagRes.json()) as Array<{ name: string }>;
      if (tags.length) return tags[0].name;
      throw new Error(`No releases or tags found for ${repo}`);
    }
    if (shouldFallback(tagRes.status) && withCliFallback && isGhAvailable()) {
      return resolveRefViaCli(repo, host);
    }
    throw new Error(
      `Failed to resolve $latest for ${repo}: HTTP ${tagRes.status}`,
    );
  }
  if (shouldFallback(relRes.status) && withCliFallback && isGhAvailable()) {
    return resolveRefViaCli(repo, host);
  }
  throw new Error(
    `Failed to resolve $latest for ${repo}: HTTP ${relRes.status}`,
  );
}

function resolveRefViaCli(repo: string, host?: string): string {
  const relArgs = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/releases/latest`,
    '--jq',
    '.tag_name',
  ];
  verbose(`github: gh fallback: gh ${relArgs.join(' ')}`);
  const res = ghRun(relArgs);
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  // Fall back to most recent tag
  const tagArgs = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/tags?per_page=1`,
    '--jq',
    '.[0].name',
  ];
  verbose(`github: gh fallback: gh ${tagArgs.join(' ')}`);
  const tagRes = ghRun(tagArgs);
  if (tagRes.status !== 0 || !tagRes.stdout.trim()) {
    throw new Error(`No releases or tags found for ${repo}`);
  }
  return tagRes.stdout.trim();
}

export async function fetchGitHub(
  repo: string,
  file: string,
  ref: string | undefined,
  host?: string,
  via?: Via | Via[],
): Promise<GitHubResult> {
  const transports = normalizeVia(via);
  const resolvedRef = await resolveRef(repo, ref, host, transports);
  const normalizedPath = file.replace(/\/$/, '');

  if (!file.endsWith('/')) {
    const info = await fetchPathInfo(
      repo,
      normalizedPath,
      resolvedRef,
      host,
      transports,
    );
    if (info.kind === 'file') {
      return {
        files: new Map([[path.basename(normalizedPath), info.content]]),
      };
    }
  }

  const paths = await listTree(
    repo,
    normalizedPath,
    resolvedRef,
    host,
    transports,
  );
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${repo}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const entries = await Promise.all(
    paths.map(
      async (p): Promise<[string, Buffer]> => [
        path.relative(normalizedPath, p),
        await fetchFile(repo, p, resolvedRef, host, transports),
      ],
    ),
  );
  return { files: new Map(entries) };
}
