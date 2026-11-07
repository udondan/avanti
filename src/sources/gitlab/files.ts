import { verbose } from '../../logger';
import type { Via } from '../../types';
import { fetchApi, statusFallback, withTransports } from '../forge/transport';
import {
  apiHeaders,
  GLAB,
  glabApi,
  glabApiBinary,
  PER_PAGE,
  projectApiUrl,
  projectEndpoint,
} from './client';

type TreeItem = { type: string; path: string };

function fileSuffix(filePath: string, ref: string, raw = ''): string {
  return `repository/files/${encodeURIComponent(filePath)}${raw}?ref=${encodeURIComponent(ref)}`;
}

function treeSuffix(dirPath: string, ref: string, page: number): string {
  return `repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${PER_PAGE}&page=${page}`;
}

function blobPaths(items: TreeItem[]): string[] {
  return items.filter((i) => i.type === 'blob').map((i) => i.path);
}

export function detectPathType(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<'file' | 'directory'> {
  verbose(`gitlab: detecting path type for ${project}:${filePath}@${ref}`);
  const viaCli = () => detectPathTypeViaCli(project, filePath, ref, host);
  return withTransports(transports, viaCli, async (withCliFallback) => {
    const res = await fetchApi(
      GLAB,
      projectApiUrl(project, fileSuffix(filePath, ref), host),
      { headers: apiHeaders() },
      withCliFallback,
    );
    if (!res) return viaCli();
    if (res.ok) return 'file';
    if (statusFallback(GLAB, res.status, withCliFallback)) return viaCli();
    // Assume directory; downstream calls will surface the real error if wrong
    return 'directory';
  });
}

function detectPathTypeViaCli(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): 'file' | 'directory' {
  const res = glabApi(
    projectEndpoint(project, fileSuffix(filePath, ref)),
    host,
  );
  if (res.status === 0) return 'file';
  const hasExplicitHost = host?.trim() || process.env.GITLAB_HOST?.trim();
  if (hasExplicitHost && !(res.stderr + res.stdout).includes('404')) {
    throw new Error(
      `gitlab: glab failed for ${project}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return 'directory';
}

export function fetchFile(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<Buffer> {
  verbose(`gitlab: fetching ${project}:${filePath}@${ref}`);
  const viaCli = () => fetchFileViaCli(project, filePath, ref, host);
  return withTransports(transports, viaCli, async (withCliFallback) => {
    const res = await fetchApi(
      GLAB,
      projectApiUrl(project, fileSuffix(filePath, ref, '/raw'), host),
      { headers: apiHeaders() },
      withCliFallback,
    );
    if (!res) return viaCli();
    if (!res.ok) {
      if (statusFallback(GLAB, res.status, withCliFallback)) return viaCli();
      throw new Error(
        `Failed to fetch ${filePath} from ${project}@${ref}: HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  });
}

function fetchFileViaCli(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): Buffer {
  const endpoint = projectEndpoint(project, fileSuffix(filePath, ref, '/raw'));
  const res = glabApiBinary(endpoint, host);
  if (res.status !== 0) {
    throw new Error(
      `Failed to fetch ${filePath} from ${project}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout;
}

export function listTree(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string[]> {
  verbose(`gitlab: listing tree ${project}:${dirPath}@${ref}`);
  const viaCli = () => listTreeViaCli(project, dirPath, ref, host);
  return withTransports(transports, viaCli, async (withCliFallback) => {
    const allPaths: string[] = [];
    for (let page = 1; ; page++) {
      const res = await fetchApi(
        GLAB,
        projectApiUrl(project, treeSuffix(dirPath, ref, page), host),
        { headers: apiHeaders() },
        withCliFallback,
      );
      if (!res) return viaCli();
      if (!res.ok) {
        if (statusFallback(GLAB, res.status, withCliFallback)) return viaCli();
        throw new Error(
          `Failed to list tree ${dirPath} in ${project}@${ref}: HTTP ${res.status}`,
        );
      }
      const items = (await res.json()) as TreeItem[];
      allPaths.push(...blobPaths(items));
      if (items.length < PER_PAGE) return allPaths;
    }
  });
}

function listTreeViaCli(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
): string[] {
  const allPaths: string[] = [];
  for (let page = 1; ; page++) {
    const endpoint = projectEndpoint(project, treeSuffix(dirPath, ref, page));
    const res = glabApi(endpoint, host);
    if (res.status !== 0) {
      throw new Error(
        `Failed to list tree ${dirPath} in ${project}@${ref}: ${res.stderr}`,
      );
    }
    const items = JSON.parse(res.stdout) as TreeItem[];
    allPaths.push(...blobPaths(items));
    if (items.length < PER_PAGE) return allPaths;
  }
}
