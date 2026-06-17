import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';
import { compilePatterns, expandBraces, matchesAnyPattern } from '../filter';
import { verbose } from '../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  maxSemverTag,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../ref';
import type { Via } from '../types';

function normalizeVia(via?: Via | Via[]): Via[] {
  if (!via) return ['api', 'cli'];
  if (Array.isArray(via)) {
    if (via.length === 0) throw new Error('via: array must not be empty');
    return [...via];
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

async function getErrorDetail(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().includes('json')) return '';
  const body = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  return typeof body?.message === 'string' && body.message
    ? `: ${body.message}`
    : '';
}

async function githubHttpError(
  res: Response,
  context: string,
): Promise<HttpError> {
  const detail = await getErrorDetail(res);
  return new HttpError(res.status, `${context}: HTTP ${res.status}${detail}`);
}

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
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
  throw await githubHttpError(
    res,
    `Failed to fetch ${filePath} from ${repo}@${ref}`,
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
    throw await githubHttpError(
      res,
      `Failed to list tree ${dirPath} in ${repo}@${ref}`,
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
  const jqPrefix = JSON.stringify(`${dirPath}/`);
  const args = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    '--jq',
    `if .truncated then error("truncated") else .tree[] | select(.type == "blob") | select(.path | startswith(${jqPrefix})) | .path end`,
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

async function findHighestSemverTagApi(
  repo: string,
  host?: string,
): Promise<string | null> {
  let best: string | null = null;
  const perPage = 100;
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/tags?per_page=${perPage}&page=${page}`,
      { headers: apiHeaders() },
    );
    if (!res.ok) {
      throw await githubHttpError(res, `Failed to list tags for ${repo}`);
    }
    const tags = (await res.json()) as Array<{ name: string }>;
    const candidate = maxSemverTag(tags.map((t) => t.name));
    if (candidate && (!best || maxSemverTag([best, candidate]) === candidate))
      best = candidate;
    if (tags.length < perPage) break;
  }
  return best;
}

async function findTagMatchingPatternApi(
  repo: string,
  pattern: RegExp,
  host?: string,
): Promise<string | null> {
  const perPage = 100;
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/tags?per_page=${perPage}&page=${page}`,
      { headers: apiHeaders() },
    );
    if (!res.ok) {
      throw await githubHttpError(res, `Failed to list tags for ${repo}`);
    }
    const tags = (await res.json()) as Array<{ name: string }>;
    const found = tags.find((t) => pattern.test(t.name));
    if (found) return found.name;
    if (tags.length < perPage) break;
  }
  return null;
}

function findTagMatchingPatternCli(
  repo: string,
  pattern: RegExp,
  host?: string,
): string | null {
  const args = [
    'api',
    ...hostnameArgs(host),
    '--paginate',
    `repos/${repo}/tags`,
    '--jq',
    '.[].name',
  ];
  verbose(`github: gh: gh ${args.join(' ')}`);
  const res = ghRun(args);
  if (res.status !== 0)
    throw new Error(
      `Failed to list tags for ${repo}: ${res.stderr.trim() || 'gh exited with status ' + res.status}`,
    );
  return (
    res.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .find((n) => pattern.test(n)) ?? null
  );
}

function findHighestSemverTagCli(repo: string, host?: string): string | null {
  const args = [
    'api',
    ...hostnameArgs(host),
    '--paginate',
    `repos/${repo}/tags`,
    '--jq',
    '.[].name',
  ];
  verbose(`github: gh: gh ${args.join(' ')}`);
  const res = ghRun(args);
  if (res.status !== 0)
    throw new Error(
      `Failed to list tags for ${repo}: ${res.stderr.trim() || 'gh exited with status ' + res.status}`,
    );
  return maxSemverTag(res.stdout.trim().split('\n').filter(Boolean));
}

async function resolveRef(
  repo: string,
  ref: string | undefined,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  const pattern = ref ? parseRefPattern(ref) : null;
  if (!isLatestSentinel(ref) && !isRecentSentinel(ref) && !pattern) {
    return ref || 'HEAD';
  }

  verbose(`github: resolving "${ref}" for ${repo}`);

  if (transports[0] === 'cli') {
    try {
      return resolveRefViaCli(repo, ref!, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }
  const withCliFallback = transports[0] === 'api' && transports.includes('cli');

  // Pattern: paginate tags and return first match
  if (pattern) {
    let found: string | null;
    try {
      found = await findTagMatchingPatternApi(repo, pattern, host);
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
        verbose(`github: HTTP fetch failed, falling back to gh`);
        return resolveRefViaCli(repo, ref!, host);
      }
      if (
        e instanceof HttpError &&
        shouldFallback(e.status) &&
        withCliFallback &&
        isGhAvailable()
      ) {
        verbose(`github: API returned ${e.status}, falling back to gh`);
        return resolveRefViaCli(repo, ref!, host);
      }
      throw e;
    }
    if (found !== null) return found;
    throw new Error(`No tags matching "${ref}" found for ${repo}`);
  }

  // $latest: try releases/latest first (semantic "latest stable release"), then scan semver tags
  if (isLatestSentinel(ref)) {
    let relRes: Response;
    try {
      relRes = await fetchWithRetry(
        `${getApiBase(host)}/repos/${repo}/releases/latest`,
        { headers: apiHeaders() },
      );
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
        verbose(`github: HTTP fetch failed, falling back to gh`);
        return resolveRefViaCli(repo, ref!, host);
      }
      throw e;
    }
    if (relRes.ok) {
      const rel = (await relRes.json()) as { tag_name: string };
      if (SEMVER_PATTERN.test(rel.tag_name)) return rel.tag_name;
      // non-semver release tag: fall through to tag scan
    } else if (relRes.status !== 404) {
      if (shouldFallback(relRes.status) && withCliFallback && isGhAvailable()) {
        return resolveRefViaCli(repo, ref!, host);
      }
      throw await githubHttpError(
        relRes,
        `Failed to resolve "${ref}" for ${repo}`,
      );
    }
    let found: string | null;
    try {
      found = await findHighestSemverTagApi(repo, host);
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
        verbose(`github: HTTP fetch failed, falling back to gh`);
        return resolveRefViaCli(repo, ref!, host);
      }
      if (
        e instanceof HttpError &&
        shouldFallback(e.status) &&
        withCliFallback &&
        isGhAvailable()
      ) {
        verbose(`github: API returned ${e.status}, falling back to gh`);
        return resolveRefViaCli(repo, ref!, host);
      }
      throw e;
    }
    if (found !== null) return found;
    throw new Error(
      `No semver tags found for ${repo} (needed to resolve $latest)`,
    );
  }

  // $recent: most recently created tag (not releases/latest, which reflects publication order)
  let tagRes: Response;
  try {
    tagRes = await fetchWithRetry(
      `${getApiBase(host)}/repos/${repo}/tags?per_page=1`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
      verbose(`github: HTTP fetch failed, falling back to gh`);
      return resolveRefViaCli(repo, ref!, host);
    }
    throw e;
  }
  if (tagRes.ok) {
    const tags = (await tagRes.json()) as Array<{ name: string }>;
    if (tags.length) return tags[0].name;
    throw new Error(`No tags found for ${repo} (needed to resolve $recent)`);
  }
  if (shouldFallback(tagRes.status) && withCliFallback && isGhAvailable()) {
    return resolveRefViaCli(repo, ref!, host);
  }
  throw await githubHttpError(tagRes, `Failed to resolve "${ref}" for ${repo}`);
}

function resolveRefViaCli(repo: string, ref: string, host?: string): string {
  const pattern = parseRefPattern(ref);

  if (pattern) {
    const found = findTagMatchingPatternCli(repo, pattern, host);
    if (found !== null) return found;
    throw new Error(`No tags matching "${ref}" found for ${repo}`);
  }

  // $latest: try releases/latest first, then scan semver tags
  if (isLatestSentinel(ref)) {
    const relArgs = [
      'api',
      ...hostnameArgs(host),
      `repos/${repo}/releases/latest`,
      '--jq',
      '.tag_name',
    ];
    verbose(`github: gh fallback: gh ${relArgs.join(' ')}`);
    const res = ghRun(relArgs);
    if (res.status === 0 && res.stdout.trim()) {
      const tag = res.stdout.trim();
      if (SEMVER_PATTERN.test(tag)) return tag;
      // non-semver release: fall through to tag search
    }
    const found = findHighestSemverTagCli(repo, host);
    if (found !== null) return found;
    throw new Error(
      `No semver tags found for ${repo} (needed to resolve $latest)`,
    );
  }

  // $recent: most recently created tag (not releases/latest, which reflects publication order)
  const tagArgs = [
    'api',
    ...hostnameArgs(host),
    `repos/${repo}/tags?per_page=1`,
    '--jq',
    '.[0].name',
  ];
  verbose(`github: gh fallback: gh ${tagArgs.join(' ')}`);
  const tagRes = ghRun(tagArgs);
  if (tagRes.status !== 0)
    throw new Error(
      `Failed to list tags for ${repo}: ${tagRes.stderr.trim() || 'gh exited with status ' + tagRes.status}`,
    );
  const tagName = tagRes.stdout.trim();
  if (!tagName || tagName === 'null')
    throw new Error(`No tags found for ${repo} (needed to resolve $recent)`);
  return tagName;
}

interface GitHubAsset {
  id: number;
  name: string;
}

async function fetchReleaseAssetsViaApi(
  repo: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Promise<Map<string, Buffer>> {
  const res = await fetchWithRetry(
    `${getApiBase(host)}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw await githubHttpError(
      res,
      `Failed to fetch release ${tag} from ${repo}`,
    );
  }
  const rel = (await res.json()) as { assets: GitHubAsset[] };
  if (!rel.assets.length) {
    throw new Error(`No release assets found for ${repo}@${tag}`);
  }
  let assets = rel.assets;
  if (preFilter && preFilter.length > 0) {
    const compiled = compilePatterns(preFilter);
    assets = assets.filter((a) =>
      matchesAnyPattern(path.basename(a.name), compiled),
    );
    if (assets.length === 0) return new Map();
  }
  const entries = await Promise.all(
    assets.map(async (asset): Promise<[string, Buffer]> => {
      const dlRes = await fetchWithRetry(
        `${getApiBase(host)}/repos/${repo}/releases/assets/${asset.id}`,
        {
          headers: { ...apiHeaders(), Accept: 'application/octet-stream' },
          redirect: 'follow',
        },
      );
      if (!dlRes.ok) {
        throw await githubHttpError(
          dlRes,
          `Failed to download release asset "${asset.name}" from ${repo}@${tag}`,
        );
      }
      return [
        path.basename(asset.name),
        Buffer.from(await dlRes.arrayBuffer()),
      ];
    }),
  );
  return new Map(entries);
}

function fetchReleaseAssetsViaCli(
  repo: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Map<string, Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-gh-rel-'));
  try {
    const args = [
      'release',
      'download',
      tag,
      '--repo',
      repo,
      '--dir',
      tmpDir,
      ...hostnameArgs(host),
    ];
    // Pass each filter pattern as --pattern so gh only fetches matching
    // assets. gh's --pattern is glob-only: regex patterns (/pat/) and brace
    // expansions ({a,b}) are not understood. Detect any regex pattern and fall
    // back to downloading all assets (the compiled filter below handles
    // correctness). For non-regex filters, expand braces first and pass each
    // resulting glob as a separate --pattern arg.
    if (preFilter && preFilter.length > 0) {
      const hasRegex = preFilter.some((p) => p.startsWith('/'));
      if (!hasRegex) {
        const expanded: string[] = [];
        for (const p of preFilter) {
          if (p.includes('{') && !p.endsWith('/')) {
            expanded.push(...expandBraces(p));
          } else {
            expanded.push(p);
          }
        }
        for (const p of expanded) {
          args.push('--pattern', p);
        }
      }
    }
    verbose(`github: gh release download: gh ${args.join(' ')}`);
    const result = ghRun(args);
    if (result.status !== 0) {
      throw new Error(
        `Failed to download release ${tag} from ${repo}: ${result.stderr}`,
      );
    }
    const compiled =
      preFilter && preFilter.length > 0
        ? compilePatterns(preFilter)
        : undefined;
    const files = new Map<string, Buffer>();
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        (!compiled || matchesAnyPattern(entry.name, compiled))
      ) {
        files.set(entry.name, fs.readFileSync(path.join(tmpDir, entry.name)));
      }
    }
    if (!files.size && !preFilter?.length) {
      throw new Error(`No release assets found for ${repo}@${tag}`);
    }
    return files;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function fetchGitHubRelease(
  repo: string,
  release: string,
  host?: string,
  via?: Via | Via[],
  preFilter?: string[],
): Promise<GitHubResult> {
  const transports = normalizeVia(via);
  const tag = await resolveRef(repo, release, host, transports);
  verbose(`github: fetching release assets for ${repo}@${tag}`);

  if (transports[0] === 'cli') {
    try {
      return { files: fetchReleaseAssetsViaCli(repo, tag, host, preFilter) };
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  try {
    return {
      files: await fetchReleaseAssetsViaApi(repo, tag, host, preFilter),
    };
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGhAvailable()) {
      verbose(`github: HTTP fetch failed, falling back to gh`);
      return { files: fetchReleaseAssetsViaCli(repo, tag, host, preFilter) };
    }
    if (
      e instanceof HttpError &&
      shouldFallback(e.status) &&
      withCliFallback &&
      isGhAvailable()
    ) {
      verbose(`github: API returned ${e.status}, falling back to gh`);
      return { files: fetchReleaseAssetsViaCli(repo, tag, host, preFilter) };
    }
    throw e;
  }
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
