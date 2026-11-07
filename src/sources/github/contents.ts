import * as path from 'path';
import {
  DIRECTORY_FETCH_CONCURRENCY,
  mapWithConcurrency,
} from '../../concurrency';
import { verbose } from '../../logger';
import type { Via } from '../../types';
import {
  fetchApi,
  normalizeVia,
  statusFallback,
  withTransports,
} from '../forge/transport';
import {
  apiHeaders,
  encodeFilePath,
  getApiBase,
  GH,
  ghApi,
  type GitHubResult,
  githubHttpError,
} from './client';
import { resolveRef } from './ref';

type PathInfo = { kind: 'file'; content: Buffer } | { kind: 'directory' };

function decodeBase64Content(b64: string): Buffer {
  return Buffer.from(b64.replace(/\n/g, ''), 'base64');
}

function truncatedTreeError(repo: string, dirPath: string): Error {
  return new Error(
    `Repository ${repo} exceeds the GitHub Trees API limit (100,000 entries). The directory listing for ${dirPath} is incomplete. Use a more specific path to reduce the result set.`,
  );
}

function fetchPathInfo(
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<PathInfo> {
  verbose(`github: fetching ${repo}:${filePath}@${ref}`);
  const viaCli = () => fetchPathInfoViaCli(repo, filePath, ref, host);
  return withTransports(transports, viaCli, async (withCliFallback) => {
    const res = await fetchApi(
      GH,
      `${getApiBase(host)}/repos/${repo}/contents/${encodeFilePath(filePath)}?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
      withCliFallback,
    );
    if (!res) return viaCli();
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return { kind: 'directory' };
      return {
        kind: 'file',
        content: decodeBase64Content((data as { content: string }).content),
      };
    }
    if (statusFallback(GH, res.status, withCliFallback)) return viaCli();
    throw await githubHttpError(
      res,
      `Failed to fetch ${filePath} from ${repo}@${ref}`,
    );
  });
}

function fetchPathInfoViaCli(
  repo: string,
  filePath: string,
  ref: string,
  host?: string,
): PathInfo {
  const res = ghApi(
    `repos/${repo}/contents/${encodeFilePath(filePath)}?ref=${encodeURIComponent(ref)}`,
    'if type == "array" then "directory" else .content end',
    host,
    'gh fallback',
  );
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

function listTree(
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string[]> {
  verbose(`github: listing tree ${repo}:${dirPath}@${ref}`);
  const viaCli = () => listTreeViaCli(repo, dirPath, ref, host);
  return withTransports(transports, viaCli, async (withCliFallback) => {
    const res = await fetchApi(
      GH,
      `${getApiBase(host)}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: apiHeaders() },
      withCliFallback,
    );
    if (!res) return viaCli();
    if (!res.ok) {
      if (statusFallback(GH, res.status, withCliFallback)) return viaCli();
      throw await githubHttpError(
        res,
        `Failed to list tree ${dirPath} in ${repo}@${ref}`,
      );
    }
    const data = (await res.json()) as {
      truncated: boolean;
      tree: Array<{ type: string; path: string }>;
    };
    if (data.truncated) throw truncatedTreeError(repo, dirPath);
    const prefix = `${dirPath}/`;
    return data.tree
      .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
      .map((item) => item.path);
  });
}

function listTreeViaCli(
  repo: string,
  dirPath: string,
  ref: string,
  host?: string,
): string[] {
  const jqPrefix = JSON.stringify(`${dirPath}/`);
  const res = ghApi(
    `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    `if .truncated then error("truncated") else .tree[] | select(.type == "blob") | select(.path | startswith(${jqPrefix})) | .path end`,
    host,
    'gh fallback',
  );
  if (res.status !== 0) {
    if (res.stderr.includes('truncated')) {
      throw truncatedTreeError(repo, dirPath);
    }
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout.trim().split('\n').filter(Boolean);
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
  const entries = await mapWithConcurrency(
    paths,
    DIRECTORY_FETCH_CONCURRENCY,
    async (p): Promise<[string, Buffer]> => [
      path.relative(normalizedPath, p),
      await fetchFile(repo, p, resolvedRef, host, transports),
    ],
  );
  return { files: new Map(entries) };
}
