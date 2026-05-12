import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';

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

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
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

async function resolveRef(
  project: string,
  ref: string | undefined,
  host?: string,
): Promise<string> {
  if (ref === undefined || ref === '') return 'HEAD';
  if (ref === '$latest') {
    verbose(`gitlab: resolving $latest for ${project}`);
    let res: Response;
    try {
      res = await fetchWithRetry(
        `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`,
        { headers: apiHeaders() },
      );
    } catch (e) {
      if (isNetworkError(e) && isGlabAvailable()) {
        verbose(`gitlab: HTTP fetch failed, falling back to glab`);
        return resolveRefViaCli(project, host);
      }
      throw e;
    }
    if (!res.ok) {
      if (shouldFallback(res.status) && isGlabAvailable()) {
        return resolveRefViaCli(project, host);
      }
      throw new Error(
        `Failed to resolve $latest for ${project}: HTTP ${res.status}`,
      );
    }
    const tags = (await res.json()) as Array<{ name: string }>;
    if (!tags.length) {
      throw new Error(
        `No tags found for ${project} (needed to resolve $latest)`,
      );
    }
    return tags[0].name;
  }
  return ref;
}

function resolveRefViaCli(project: string, host?: string): string {
  const endpoint = `projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`;
  const res = glabApi(endpoint, host);
  if (res.status !== 0) {
    throw new Error(`Failed to resolve $latest for ${project}: ${res.stderr}`);
  }
  const tags = JSON.parse(res.stdout) as Array<{ name: string }>;
  if (!tags.length) {
    throw new Error(`No tags found for ${project} (needed to resolve $latest)`);
  }
  return tags[0].name;
}

async function detectPathType(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<'file' | 'directory'> {
  verbose(`gitlab: detecting path type for ${project}:${filePath}@${ref}`);
  const encodedPath = encodeURIComponent(filePath);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return detectPathTypeViaCli(project, filePath, ref, host);
    }
    throw e;
  }
  if (res.ok) return 'file';
  if (shouldFallback(res.status) && isGlabAvailable()) {
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
  if (host) {
    throw new Error(
      `gitlab: glab failed for ${project}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return 'directory';
}

async function fetchFile(
  project: string,
  filePath: string,
  ref: string,
  host?: string,
): Promise<Buffer> {
  verbose(`gitlab: fetching ${project}:${filePath}@${ref}`);
  const encodedPath = encodeURIComponent(filePath);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return fetchFileViaCli(project, filePath, ref, host);
    }
    throw e;
  }
  if (!res.ok) {
    if (shouldFallback(res.status) && isGlabAvailable()) {
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
): Promise<string[]> {
  verbose(`gitlab: listing tree ${project}:${dirPath}@${ref}`);
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
      if (isNetworkError(e) && isGlabAvailable()) {
        verbose(`gitlab: HTTP fetch failed, falling back to glab`);
        return listTreeViaCli(project, dirPath, ref, host);
      }
      throw e;
    }
    if (!res.ok) {
      if (shouldFallback(res.status) && isGlabAvailable()) {
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
): Promise<Map<string, Buffer> | null> {
  verbose(
    `gitlab: fetching directory via archive: ${project}:${dirPath}@${ref}`,
  );
  const encodedProject = encodeURIComponent(project);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://${getHost(host)}/api/v4/projects/${encodedProject}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`,
      { headers: apiHeaders() },
    );
  } catch (e) {
    if (isNetworkError(e) && isGlabAvailable()) {
      verbose(`gitlab: HTTP fetch failed, falling back to glab`);
      return fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
    }
    if (isNetworkError(e)) return null;
    throw e;
  }
  if (!res.ok) {
    if (shouldFallback(res.status) && isGlabAvailable()) {
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

export async function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
  host?: string,
): Promise<GitLabResult> {
  const resolvedRef = await resolveRef(project, ref, host);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    (await detectPathType(project, normalizedPath, resolvedRef, host)) ===
      'directory';

  if (!isDirectory) {
    const content = await fetchFile(project, normalizedPath, resolvedRef, host);
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  // Directory — archive approach first (one API call), then fall back to per-file fetches
  const archived = await fetchDirectoryViaArchive(
    project,
    normalizedPath,
    resolvedRef,
    host,
  );
  if (archived) return { files: archived };

  const paths = await listTree(project, normalizedPath, resolvedRef, host);
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
          await fetchFile(project, p, resolvedRef, host),
        ] as const,
    ),
  );
  return { files: new Map(entries) };
}
