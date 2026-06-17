import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
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

export interface GitLabResult {
  /** Map of relative path → content */
  files: Map<string, Buffer>;
}

function getHost(override?: string): string {
  return override?.trim() || process.env.GITLAB_HOST?.trim() || 'gitlab.com';
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'avanti' };
  const token = process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN;
  if (token) headers['PRIVATE-TOKEN'] = token;
  return headers;
}

// Extracts the token from `glab auth status --show-token` output for a specific
// host. The output is grouped by instance (one section per configured host);
// host headers appear at column 0 (no leading whitespace) while details are
// indented. We find the section for targetHost (matching the bare name or the
// ssh.* variant that glab may store internally) and return the "Token found:"
// value from within that section only, avoiding wrong-instance token selection
// in multi-instance configs where the first regex match could be for a
// different host that appears earlier in the output.
function tokenForHost(output: string, targetHost: string): string | undefined {
  const normalized = targetHost.toLowerCase().replace(/^ssh\./, '');
  const lines = output.split('\n');
  let inSection = false;
  for (const line of lines) {
    // Host headers start at column 0 (not indented)
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      const t = line.trim().toLowerCase();
      inSection =
        t === normalized ||
        t === 'ssh.' + normalized ||
        t.startsWith(normalized + ' ') ||
        t.startsWith('ssh.' + normalized + ' ');
    }
    if (inSection) {
      const m = line.match(/Token found:\s*(\S+)/);
      if (m) return m[1];
    }
  }
  return undefined;
}

// Returns the best available auth token: env var first, then glab's stored
// credentials via `glab auth status --show-token`.
// glab may store the instance under a different hostname key (e.g.
// ssh.hostname when the avanti config uses hostname), so we try with
// --hostname first and fall back to no --hostname to get any available token.
// Output may be on stdout or stderr depending on glab version, so we check
// both streams.
function resolveToken(host?: string): string | undefined {
  const envToken = process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN;
  if (envToken) return envToken;
  const attempts: string[][] = [
    ['auth', 'status', '--show-token', ...hostnameArgs(host)],
  ];
  const configuredHost = host?.trim() || process.env.GITLAB_HOST?.trim();
  if (hostnameArgs(host).length > 0) {
    // Fallback without --hostname in case glab uses a different key for this
    // instance (e.g. ssh.git.example.com vs git.example.com). Use --all to
    // enumerate every configured instance regardless of the current git context,
    // then tokenForHost() picks the right section. Unset GITLAB_HOST so glab
    // doesn't re-apply the env-override we already tried with --hostname.
    attempts.push(['auth', 'status', '--show-token', '--all']);
  }
  for (let i = 0; i < attempts.length; i++) {
    const args = attempts[i];
    // For the fallback attempt, unset GITLAB_HOST so glab picks its stored
    // default context rather than the env-override we already tried with --hostname.
    const res =
      i > 0
        ? (() => {
            const env = { ...process.env };
            delete env['GITLAB_HOST'];
            return spawnSync('glab', args, { encoding: 'utf8', env });
          })()
        : spawnSync('glab', args, { encoding: 'utf8' });
    const output = (res.stdout ?? '') + (res.stderr ?? '');
    // For the scoped attempt (--hostname): output is already host-scoped, use
    // simple regex. For the fallback (no --hostname): extract the token from the
    // specific host section to avoid returning the wrong instance's token when
    // multiple instances are configured.
    const token =
      i > 0 && configuredHost
        ? tokenForHost(output, configuredHost)
        : output.match(/Token found:\s*(\S+)/)?.[1];
    if (token) {
      if (i > 0 && configuredHost) {
        verbose(
          `gitlab: resolved auth token via glab auth status (no --hostname, host verified)`,
        );
      } else if (i > 0) {
        verbose(
          `gitlab: resolved auth token via glab auth status (no --hostname; token may be for a different instance)`,
        );
      } else {
        verbose(`gitlab: resolved auth token via glab auth status`);
      }
      return token;
    }
  }
  return undefined;
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

function isGlabAvailable(): boolean {
  return !spawnSync('glab', ['--version'], { encoding: 'utf8' }).error;
}

function hostnameArgs(host?: string): string[] {
  const resolved = host?.trim() || process.env.GITLAB_HOST?.trim() || '';
  return resolved ? ['--hostname', resolved] : [];
}

function glabRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('glab', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`glab error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function glabRunBinary(args: string[]): {
  stdout: Buffer;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('glab', args, {
    encoding: 'buffer',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.error) throw new Error(`glab error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.toString('utf8') ?? '',
    status: result.status,
  };
}

function glabApi(endpoint: string, host?: string): ReturnType<typeof glabRun> {
  const args = ['api', ...hostnameArgs(host), endpoint];
  verbose(`gitlab: glab fallback: glab ${args.join(' ')}`);
  const res = glabRun(args);
  if (res.status === 0) verbose(`  -> glab ok`);
  else verbose(`  -> glab failed (exit ${res.status})`);
  return res;
}

function glabApiBinary(
  endpoint: string,
  host?: string,
): ReturnType<typeof glabRunBinary> {
  const args = ['api', ...hostnameArgs(host), endpoint];
  verbose(`gitlab: glab fallback: glab ${args.join(' ')}`);
  const res = glabRunBinary(args);
  if (res.status === 0) verbose(`  -> glab ok (${res.stdout.length} bytes)`);
  else verbose(`  -> glab failed (exit ${res.status})`);
  return res;
}

async function findGitLabTagMatchingPatternApi(
  project: string,
  pattern: RegExp,
  host?: string,
  sortBy: 'updated' | 'version' = 'updated',
): Promise<string | null> {
  const perPage = 100;
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/tags?order_by=${sortBy}&sort=desc&per_page=${perPage}&page=${page}`,
      { headers: apiHeaders() },
    );
    if (!res.ok)
      throw new HttpError(
        res.status,
        `Failed to list tags for ${project}: HTTP ${res.status}`,
      );
    const tags = (await res.json()) as Array<{ name: string }>;
    const found = tags.find((t) => pattern.test(t.name));
    if (found) return found.name;
    if (tags.length < perPage) break;
  }
  return null;
}

function findGitLabTagMatchingPatternCli(
  project: string,
  pattern: RegExp,
  host?: string,
  sortBy: 'updated' | 'version' = 'updated',
): string | null {
  const perPage = 100;
  for (let page = 1; ; page++) {
    const endpoint = `projects/${encodeURIComponent(project)}/repository/tags?order_by=${sortBy}&sort=desc&per_page=${perPage}&page=${page}`;
    const res = glabApi(endpoint, host);
    if (res.status !== 0)
      throw new Error(
        `Failed to list tags for ${project}: ${res.stderr.trim() || 'glab exited with status ' + res.status}`,
      );
    if (!res.stdout.trim()) break;
    const tags = JSON.parse(res.stdout) as Array<{ name: string }>;
    const found = tags.find((t) => pattern.test(t.name));
    if (found) return found.name;
    if (tags.length < perPage) break;
  }
  return null;
}

async function resolveRef(
  project: string,
  ref: string | undefined,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  if (ref === undefined || ref === '') return 'HEAD';
  const pattern = parseRefPattern(ref);
  if (!isLatestSentinel(ref) && !isRecentSentinel(ref) && !pattern) return ref;

  verbose(`gitlab: resolving "${ref}" for ${project}`);

  if (transports[0] === 'cli') {
    try {
      return resolveRefViaCli(project, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }
  const withCliFallback = transports[0] === 'api' && transports.includes('cli');

  // $recent: most-recently-updated tag (no semver filter)
  if (isRecentSentinel(ref)) {
    let res: Response;
    try {
      res = await fetchWithRetry(
        `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/tags?order_by=updated&sort=desc&per_page=1`,
        { headers: apiHeaders() },
      );
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
        verbose(`gitlab: HTTP fetch failed, falling back to glab`);
        return resolveRefViaCli(project, ref, host);
      }
      throw e;
    }
    if (!res.ok) {
      if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
        return resolveRefViaCli(project, ref, host);
      }
      throw new Error(
        `Failed to resolve $recent for ${project}: HTTP ${res.status}`,
      );
    }
    const tags = (await res.json()) as Array<{ name: string }>;
    if (!tags.length)
      throw new Error(
        `No tags found for ${project} (needed to resolve $recent)`,
      );
    return tags[0].name;
  }

  // Pattern: paginate tags sorted by most-recently-updated, filter by regex
  if (pattern) {
    let found: string | null;
    try {
      found = await findGitLabTagMatchingPatternApi(project, pattern, host);
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
        verbose(`gitlab: HTTP fetch failed, falling back to glab`);
        return resolveRefViaCli(project, ref, host);
      }
      if (
        e instanceof HttpError &&
        shouldFallback(e.status) &&
        withCliFallback &&
        isGlabAvailable()
      ) {
        verbose(`gitlab: API returned ${e.status}, falling back to glab`);
        return resolveRefViaCli(project, ref, host);
      }
      throw e;
    }
    if (found !== null) return found;
    throw new Error(`No tags matching "${ref}" found for ${project}`);
  }

  // $latest: semver-sorted tags (GitLab's version ordering is semver-aware),
  // filtered by SEMVER_PATTERN to skip non-semver tags that sort first
  let found: string | null;
  try {
    found = await findGitLabTagMatchingPatternApi(
      project,
      SEMVER_PATTERN,
      host,
      'version',
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return resolveRefViaCli(project, ref, host);
    }
    if (
      e instanceof HttpError &&
      shouldFallback(e.status) &&
      withCliFallback &&
      isGlabAvailable()
    ) {
      verbose(`gitlab: API returned ${e.status}, falling back to glab`);
      return resolveRefViaCli(project, ref, host);
    }
    throw e;
  }
  if (found !== null) return found;
  throw new Error(
    `No semver tags found for ${project} (needed to resolve $latest)`,
  );
}

function resolveRefViaCli(project: string, ref: string, host?: string): string {
  const pattern = parseRefPattern(ref);

  if (pattern) {
    const found = findGitLabTagMatchingPatternCli(project, pattern, host);
    if (found !== null) return found;
    throw new Error(`No tags matching "${ref}" found for ${project}`);
  }

  if (isRecentSentinel(ref)) {
    const endpoint = `projects/${encodeURIComponent(project)}/repository/tags?order_by=updated&sort=desc&per_page=1`;
    const res = glabApi(endpoint, host);
    if (res.status !== 0) {
      throw new Error(
        `Failed to resolve $recent for ${project}: ${res.stderr}`,
      );
    }
    if (!res.stdout.trim())
      throw new Error(
        `No tags found for ${project} (needed to resolve $recent)`,
      );
    const tags = JSON.parse(res.stdout) as Array<{ name: string }>;
    if (!tags.length)
      throw new Error(
        `No tags found for ${project} (needed to resolve $recent)`,
      );
    return tags[0].name;
  }

  // $latest: semver-sorted, filtered by SEMVER_PATTERN
  const found = findGitLabTagMatchingPatternCli(
    project,
    SEMVER_PATTERN,
    host,
    'version',
  );
  if (found !== null) return found;
  throw new Error(
    `No semver tags found for ${project} (needed to resolve $latest)`,
  );
}

async function detectPathType(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<'file' | 'directory'> {
  verbose(`gitlab: detecting path type for ${project}:${filePath}@${ref}`);

  if (transports[0] === 'cli') {
    try {
      return detectPathTypeViaCli(project, filePath, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  const encodedPath = encodeURIComponent(filePath);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return detectPathTypeViaCli(project, filePath, ref, host);
    }
    throw e;
  }
  if (res.ok) return 'file';
  if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
    return detectPathTypeViaCli(project, filePath, ref, host);
  }
  // Assume directory; downstream calls will surface the real error if wrong
  return 'directory';
}

function detectPathTypeViaCli(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): 'file' | 'directory' {
  const endpoint = `projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
  const res = glabApi(endpoint, host);
  if (res.status === 0) return 'file';
  if (host?.trim() || process.env.GITLAB_HOST?.trim()) {
    const combined = res.stderr + res.stdout;
    if (!combined.includes('404')) {
      throw new Error(
        `gitlab: glab failed for ${project}: ${(res.stderr || res.stdout).trim()}`,
      );
    }
  }
  return 'directory';
}

async function fetchFile(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<Buffer> {
  verbose(`gitlab: fetching ${project}:${filePath}@${ref}`);

  if (transports[0] === 'cli') {
    try {
      return fetchFileViaCli(project, filePath, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  const encodedPath = encodeURIComponent(filePath);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return fetchFileViaCli(project, filePath, ref, host);
    }
    throw e;
  }
  if (!res.ok) {
    if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
      return fetchFileViaCli(project, filePath, ref, host);
    }
    throw new Error(
      `Failed to fetch ${filePath} from ${project}@${ref}: HTTP ${res.status}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function fetchFileViaCli(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): Buffer {
  const endpoint = `projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
  const res = glabApiBinary(endpoint, host);
  if (res.status !== 0) {
    throw new Error(
      `Failed to fetch ${filePath} from ${project}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout;
}

async function listTree(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string[]> {
  verbose(`gitlab: listing tree ${project}:${dirPath}@${ref}`);

  if (transports[0] === 'cli') {
    try {
      return listTreeViaCli(project, dirPath, ref, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  const allPaths: string[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    let res: Response;
    try {
      res = await fetchWithRetry(
        `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${perPage}&page=${page}`,
        { headers: apiHeaders() },
      );
    } catch (e) {
      if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
        verbose(`gitlab: HTTP fetch failed, falling back to glab`);
        return listTreeViaCli(project, dirPath, ref, host);
      }
      throw e;
    }
    if (!res.ok) {
      if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
        return listTreeViaCli(project, dirPath, ref, host);
      }
      throw new Error(
        `Failed to list tree ${dirPath} in ${project}@${ref}: HTTP ${res.status}`,
      );
    }
    const items = (await res.json()) as Array<{ type: string; path: string }>;
    allPaths.push(...items.filter((i) => i.type === 'blob').map((i) => i.path));
    if (items.length < perPage) break;
    page++;
  }

  return allPaths;
}

function listTreeViaCli(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
): string[] {
  const allPaths: string[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const endpoint = `projects/${encodeURIComponent(project)}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${perPage}&page=${page}`;
    const res = glabApi(endpoint, host);
    if (res.status !== 0) {
      throw new Error(
        `Failed to list tree ${dirPath} in ${project}@${ref}: ${res.stderr}`,
      );
    }
    const items = JSON.parse(res.stdout) as Array<{
      type: string;
      path: string;
    }>;
    allPaths.push(...items.filter((i) => i.type === 'blob').map((i) => i.path));
    if (items.length < perPage) break;
    page++;
  }

  return allPaths;
}

function collectFiles(
  baseDir: string,
  dir: string,
  files: Map<string, Buffer>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(baseDir, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(baseDir, full), fs.readFileSync(full));
    }
  }
}

function extractArchive(
  buf: Buffer,
  dirPath: string,
): Map<string, Buffer> | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-gl-'));
  try {
    const archivePath = path.join(tmpDir, 'archive.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.writeFileSync(archivePath, buf);
    fs.mkdirSync(extractDir);

    const tarResult = spawnSync(
      'tar',
      ['-xzf', archivePath, '-C', extractDir],
      {
        encoding: 'utf8',
      },
    );
    if (tarResult.status !== 0) return null;

    const rootEntries = fs.readdirSync(extractDir);
    if (rootEntries.length !== 1) return null;

    const targetDir = path.join(extractDir, rootEntries[0], dirPath);
    if (!fs.existsSync(targetDir)) return null;

    const files = new Map<string, Buffer>();
    collectFiles(targetDir, targetDir, files);
    return files.size > 0 ? files : null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function fetchDirectoryViaArchive(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<Map<string, Buffer> | null> {
  verbose(
    `gitlab: fetching directory via archive: ${project}:${dirPath}@${ref}`,
  );

  if (transports[0] === 'cli') {
    const result = fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
    if (result !== null || !transports.includes('api')) return result;
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  const encodedProject = encodeURIComponent(project);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodedProject}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
    }
    if (isNetworkError(e)) return null;
    throw e;
  }
  if (!res.ok) {
    if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
      return fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
    }
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return null;
  return extractArchive(buf, dirPath);
}

function fetchDirectoryViaArchiveViaCli(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
): Map<string, Buffer> | null {
  const endpoint = `projects/${encodeURIComponent(project)}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`;
  let res: ReturnType<typeof glabRunBinary>;
  try {
    res = glabApiBinary(endpoint, host);
  } catch {
    return null;
  }
  if (res.status !== 0 || !res.stdout.length) return null;
  return extractArchive(res.stdout, dirPath);
}

interface GitLabReleaseLink {
  name: string;
  url: string;
  direct_asset_url?: string;
  link_type: string;
}

async function resolveReleaseTag(
  project: string,
  release: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<string> {
  const pattern = parseRefPattern(release);
  if (!isLatestSentinel(release) && !isRecentSentinel(release) && !pattern) {
    return release;
  }

  verbose(`gitlab: resolving "${release}" release for ${project}`);

  if (transports[0] === 'cli') {
    try {
      return resolveReleaseTagViaCli(project, release, host);
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }
  const withCliFallback = transports[0] === 'api' && transports.includes('cli');

  // $recent or pattern: paginate releases sorted by released_at desc
  if (isRecentSentinel(release) || pattern) {
    const perPage = 100;
    for (let page = 1; ; page++) {
      let res: Response;
      try {
        res = await fetchWithRetry(
          `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/releases?order_by=released_at&sort=desc&per_page=${perPage}&page=${page}`,
          { headers: apiHeaders() },
        );
      } catch (e) {
        if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
          verbose(`gitlab: HTTP fetch failed, falling back to glab`);
          return resolveReleaseTagViaCli(project, release, host);
        }
        throw e;
      }
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) {
          if (withCliFallback && isGlabAvailable())
            return resolveReleaseTagViaCli(project, release, host);
          return resolveRef(project, release, host, transports);
        }
        if (
          shouldFallback(res.status) &&
          withCliFallback &&
          isGlabAvailable()
        ) {
          return resolveReleaseTagViaCli(project, release, host);
        }
        throw new Error(
          `Failed to resolve "${release}" release for ${project}: HTTP ${res.status}`,
        );
      }
      const releases = (await res.json()) as Array<{ tag_name: string }>;
      if (isRecentSentinel(release)) {
        if (releases.length) return releases[0].tag_name;
        return resolveRef(project, '$recent', host, transports);
      }
      const found = releases.find((r) => pattern!.test(r.tag_name));
      if (found) return found.tag_name;
      if (releases.length < perPage) break;
    }
    throw new Error(`No releases matching "${release}" found for ${project}`);
  }

  // $latest: use GitLab's releases/latest endpoint
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/releases/latest`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return resolveReleaseTagViaCli(project, release, host);
    }
    throw e;
  }
  if (res.ok) {
    const rel = (await res.json()) as { tag_name: string };
    // $latest must be a stable semver tag; if not, fall through to semver tag scan
    if (SEMVER_PATTERN.test(rel.tag_name)) return rel.tag_name;
  }
  // Releases endpoint unavailable (older GitLab) or non-semver latest — fall back to tags
  if (!res.ok && res.status !== 404 && res.status !== 403) {
    if (shouldFallback(res.status) && withCliFallback && isGlabAvailable()) {
      return resolveReleaseTagViaCli(project, release, host);
    }
    throw new Error(
      `Failed to resolve $latest release for ${project}: HTTP ${res.status}`,
    );
  }
  if (res.status === 404 || res.status === 403) {
    if (withCliFallback && isGlabAvailable()) {
      return resolveReleaseTagViaCli(project, release, host);
    }
  }
  // Fallback to semver tag scan (also handles non-semver releases/latest)
  return resolveRef(project, '$latest', host, transports);
}

function resolveReleaseTagViaCli(
  project: string,
  release: string,
  host?: string,
): string {
  const pattern = parseRefPattern(release);

  if (pattern || isRecentSentinel(release)) {
    const perPage = 100;
    for (let page = 1; ; page++) {
      const endpoint = `projects/${encodeURIComponent(project)}/releases?order_by=released_at&sort=desc&per_page=${perPage}&page=${page}`;
      const res = glabApi(endpoint, host);
      if (res.status !== 0)
        throw new Error(
          `Failed to list releases for ${project}: ${res.stderr.trim() || 'glab exited with status ' + res.status}`,
        );
      if (!res.stdout.trim()) break;
      try {
        const releases = JSON.parse(res.stdout) as Array<{ tag_name: string }>;
        if (isRecentSentinel(release)) {
          if (releases.length) return releases[0].tag_name;
          break;
        }
        const found = releases.find((r) => pattern!.test(r.tag_name));
        if (found) return found.tag_name;
        if (releases.length < perPage) break;
      } catch (e) {
        if (e instanceof SyntaxError) break;
        throw e;
      }
    }
    if (pattern) {
      throw new Error(`No releases matching "${release}" found for ${project}`);
    }
    // $recent with no releases: fall back to tags
    const tagsEndpoint = `projects/${encodeURIComponent(project)}/repository/tags?order_by=updated&sort=desc&per_page=1`;
    const tagRes = glabApi(tagsEndpoint, host);
    if (tagRes.status !== 0) {
      throw new Error(
        `Failed to resolve "${release}" release for ${project}: ${tagRes.stderr}`,
      );
    }
    if (!tagRes.stdout.trim())
      throw new Error(
        `No releases or tags found for ${project} (needed to resolve ${release})`,
      );
    const tags = JSON.parse(tagRes.stdout) as Array<{ name: string }>;
    if (!tags.length) {
      throw new Error(
        `No releases or tags found for ${project} (needed to resolve ${release})`,
      );
    }
    return tags[0].name;
  }

  // $latest
  const endpoint = `projects/${encodeURIComponent(project)}/releases/latest`;
  const res = glabApi(endpoint, host);
  if (res.status === 0 && res.stdout.trim()) {
    try {
      const rel = JSON.parse(res.stdout) as { tag_name: string };
      // $latest must be a stable semver tag; if not, fall through to semver tag scan
      if (rel.tag_name && SEMVER_PATTERN.test(rel.tag_name))
        return rel.tag_name;
    } catch {
      // fall through to tags
    }
  }
  // Fall back to semver tag scan (also handles non-semver releases/latest)
  const tagsEndpoint = `projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`;
  const tagRes = glabApi(tagsEndpoint, host);
  if (tagRes.status !== 0) {
    throw new Error(
      `Failed to resolve $latest release for ${project}: ${tagRes.stderr}`,
    );
  }
  if (!tagRes.stdout.trim())
    throw new Error(
      `No releases or tags found for ${project} (needed to resolve $latest)`,
    );
  const tags = JSON.parse(tagRes.stdout) as Array<{ name: string }>;
  if (!tags.length) {
    throw new Error(
      `No releases or tags found for ${project} (needed to resolve $latest)`,
    );
  }
  return tags[0].name;
}

// Follows HTTP redirects while ensuring the PRIVATE-TOKEN header is only sent
// to the originating GitLab host, not forwarded to external redirect targets
// (e.g. pre-signed S3/GCS URLs that release assets may redirect to).
async function fetchWithHostBoundRedirects(
  url: string,
  headers: Record<string, string>,
  gitlabHost: string,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = url;
  let currentHeaders = headers;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchWithRetry(currentUrl, {
      headers: currentHeaders,
      redirect: 'manual',
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    const resolvedLocation = new URL(location, currentUrl).href;
    const redirectHost = new URL(resolvedLocation).host;
    currentHeaders =
      redirectHost === gitlabHost ? headers : { 'User-Agent': 'avanti' };
    currentUrl = resolvedLocation;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

async function fetchReleaseLinksViaApi(
  project: string,
  tag: string,
  host?: string,
): Promise<Map<string, Buffer>> {
  const rawHost = getHost(host);
  const gitlabHost = new URL(`https://${rawHost}`).host;
  const res = await fetchWithRetry(
    `https://${gitlabHost}/api/v4/projects/${encodeURIComponent(project)}/releases/${encodeURIComponent(tag)}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `Failed to fetch release ${tag} from ${project}: HTTP ${res.status}`,
    );
  }
  const rel = (await res.json()) as {
    assets: { links: GitLabReleaseLink[] };
  };
  let links = rel.assets.links.filter((l) => l.link_type === 'package');
  if (!links.length) links = rel.assets.links;
  if (!links.length) {
    throw new Error(`No release assets found for ${project}@${tag}`);
  }
  const entries = await Promise.all(
    links.map(async (link): Promise<[string, Buffer]> => {
      const downloadUrl = link.direct_asset_url ?? link.url;
      const linkHost = new URL(downloadUrl).host;
      const headers =
        linkHost === gitlabHost ? apiHeaders() : { 'User-Agent': 'avanti' };
      const dlRes = await fetchWithHostBoundRedirects(
        downloadUrl,
        headers,
        gitlabHost,
      );
      if (!dlRes.ok) {
        throw new Error(
          `Failed to download release asset "${link.name}" from ${project}@${tag}: HTTP ${dlRes.status}`,
        );
      }
      return [path.basename(link.name), Buffer.from(await dlRes.arrayBuffer())];
    }),
  );
  return new Map(entries);
}

async function fetchReleaseLinksViaCli(
  project: string,
  tag: string,
  host?: string,
): Promise<Map<string, Buffer>> {
  const endpoint = `projects/${encodeURIComponent(project)}/releases/${encodeURIComponent(tag)}`;
  const metaRes = glabApi(endpoint, host);
  if (metaRes.status !== 0) {
    throw new Error(
      `Failed to fetch release ${tag} from ${project}: ${metaRes.stderr}`,
    );
  }
  const rel = JSON.parse(metaRes.stdout) as {
    assets?: { links?: GitLabReleaseLink[] };
  };
  let links = rel.assets?.links?.filter((l) => l.link_type === 'package') ?? [];
  if (!links.length) links = rel.assets?.links ?? [];
  if (!links.length) {
    throw new Error(`No release assets found for ${project}@${tag}`);
  }

  const token = resolveToken(host);
  const files = new Map<string, Buffer>();
  const explicitGitlabHost =
    host?.trim() || process.env.GITLAB_HOST?.trim() || undefined;
  // Pre-determine the trusted GitLab host for token scoping, in priority order:
  // 1. Explicit config (host:/GITLAB_HOST) — authoritative
  // 2. Any link's direct_asset_url host — direct_asset_url always points to the
  //    GitLab instance, so any occurrence across the link set reliably identifies it
  // 3. undefined — fall back per-link to link.url's host (old GitLab instances
  //    that never populate direct_asset_url; all links are same-host there)
  const knownGitlabHost =
    explicitGitlabHost ??
    links
      .map((l) =>
        l.direct_asset_url ? new URL(l.direct_asset_url).host : null,
      )
      .find((h): h is string => h !== null);

  if (token) {
    for (const link of links) {
      // direct_asset_url is correct; link.url may have a double-slash bug when
      // the GitLab instance External URL was configured with a trailing slash
      const downloadUrl = link.direct_asset_url ?? link.url;
      const linkHost = new URL(downloadUrl).host;
      // Use the pre-computed GitLab host if known; otherwise fall back to the
      // link's own host (old GitLab without direct_asset_url, same-host assumption)
      const gitlabHost = knownGitlabHost ?? linkHost;
      const dlHeaders: Record<string, string> = { 'User-Agent': 'avanti' };
      if (linkHost === gitlabHost) dlHeaders['PRIVATE-TOKEN'] = token;
      const dlRes = await fetchWithHostBoundRedirects(
        downloadUrl,
        dlHeaders,
        gitlabHost,
      );
      if (!dlRes.ok) {
        throw new Error(
          `Failed to download release asset "${link.name}" from ${project}@${tag}: HTTP ${dlRes.status}`,
        );
      }
      files.set(
        path.basename(link.name),
        Buffer.from(await dlRes.arrayBuffer()),
      );
    }
  } else {
    // No token resolvable. Last resort: glab release download, which uses
    // glab's own authenticated HTTP client. NOTE: this will fail with 404 for
    // GitLab instances where the External URL has a trailing slash (the same
    // double-slash URL bug). Set GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN to use
    // the authenticated HTTP fetch path instead.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-glab-'));
    try {
      const args = ['release', 'download', tag, '-R', project, '-D', tmpDir];
      verbose(`gitlab: glab ${args.join(' ')}`);
      const dlRes = spawnSync('glab', args, { encoding: 'utf8' });
      if (dlRes.error) throw new Error(`glab error: ${dlRes.error.message}`);
      if (dlRes.status !== 0) {
        throw new Error(
          `glab release download failed (exit ${dlRes.status}): ${dlRes.stderr}`,
        );
      }
      for (const link of links) {
        const name = path.basename(link.name);
        const fp = path.join(tmpDir, name);
        if (fs.existsSync(fp)) files.set(name, fs.readFileSync(fp));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  if (!files.size) {
    throw new Error(`No release assets found for ${project}@${tag}`);
  }
  return files;
}

export async function fetchGitLabRelease(
  project: string,
  release: string,
  host?: string,
  via?: Via | Via[],
): Promise<GitLabResult> {
  const transports = normalizeVia(via);
  const tag = await resolveReleaseTag(project, release, host, transports);
  verbose(`gitlab: fetching release assets for ${project}@${tag}`);

  if (transports[0] === 'cli') {
    try {
      return { files: await fetchReleaseLinksViaCli(project, tag, host) };
    } catch (e) {
      if (!transports.includes('api')) throw e;
    }
  }

  const withCliFallback = transports[0] === 'api' && transports.includes('cli');
  try {
    return { files: await fetchReleaseLinksViaApi(project, tag, host) };
  } catch (e) {
    if (isNetworkError(e) && withCliFallback && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return { files: await fetchReleaseLinksViaCli(project, tag, host) };
    }
    if (
      e instanceof HttpError &&
      shouldFallback(e.status) &&
      withCliFallback &&
      isGlabAvailable()
    ) {
      verbose(`gitlab: API returned ${e.status}, falling back to glab`);
      return { files: await fetchReleaseLinksViaCli(project, tag, host) };
    }
    throw e;
  }
}

export async function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
  host?: string,
  via?: Via | Via[],
): Promise<GitLabResult> {
  const transports = normalizeVia(via);
  const resolvedRef = await resolveRef(project, ref, host, transports);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    (await detectPathType(
      project,
      normalizedPath,
      resolvedRef,
      host,
      transports,
    )) === 'directory';

  if (!isDirectory) {
    const content = await fetchFile(
      project,
      normalizedPath,
      resolvedRef,
      host,
      transports,
    );
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  // Directory — archive approach first (one API call), then fall back to per-file fetches
  const archived = await fetchDirectoryViaArchive(
    project,
    normalizedPath,
    resolvedRef,
    host,
    transports,
  );
  if (archived) return { files: archived };

  const paths = await listTree(
    project,
    normalizedPath,
    resolvedRef,
    host,
    transports,
  );
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${project}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const entries = await Promise.all(
    paths.map(
      async (p) =>
        [
          path.relative(normalizedPath, p),
          await fetchFile(project, p, resolvedRef, host, transports),
        ] as const,
    ),
  );
  return { files: new Map(entries) };
}
