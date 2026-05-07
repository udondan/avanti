import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';

export interface GitLabResult {
  /** Map of relative path → content */
  files: Map<string, string>;
}

function getHost(): string {
  return process.env.GITLAB_HOST ?? 'gitlab.com';
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'scync' };
  const token = process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN;
  if (token) headers['PRIVATE-TOKEN'] = token;
  return headers;
}

function shouldFallback(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isGlabAvailable(): boolean {
  return !spawnSync('glab', ['--version'], { encoding: 'utf8' }).error;
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

async function resolveRef(
  project: string,
  ref: string | undefined,
): Promise<string> {
  if (!ref || ref === '$latest') {
    const host = getHost();
    const res = await fetchWithRetry(
      `https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`,
      { headers: apiHeaders() },
    );
    if (!res.ok) {
      if (shouldFallback(res.status) && isGlabAvailable()) {
        return resolveRefViaCli(project);
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

function resolveRefViaCli(project: string): string {
  const res = glabRun([
    'api',
    `projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`,
  ]);
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
): Promise<'file' | 'directory'> {
  const host = getHost();
  const encodedPath = encodeURIComponent(filePath);
  const res = await fetchWithRetry(
    `https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders() },
  );
  if (res.ok) return 'file';
  if (shouldFallback(res.status) && isGlabAvailable()) {
    return detectPathTypeViaCli(project, filePath, ref);
  }
  // Assume directory; downstream calls will surface the real error if wrong
  return 'directory';
}

function detectPathTypeViaCli(
  project: string,
  filePath: string,
  ref: string,
): 'file' | 'directory' {
  const encodedPath = encodeURIComponent(filePath);
  const res = glabRun([
    'api',
    `projects/${encodeURIComponent(project)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  ]);
  return res.status === 0 ? 'file' : 'directory';
}

async function fetchFile(
  project: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const host = getHost();
  const encodedPath = encodeURIComponent(filePath);
  const res = await fetchWithRetry(
    `https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    if (shouldFallback(res.status) && isGlabAvailable()) {
      return fetchFileViaCli(project, filePath, ref);
    }
    throw new Error(
      `Failed to fetch ${filePath} from ${project}@${ref}: HTTP ${res.status}`,
    );
  }
  return res.text();
}

function fetchFileViaCli(
  project: string,
  filePath: string,
  ref: string,
): string {
  const encodedPath = encodeURIComponent(filePath);
  const res = glabRun([
    'api',
    `projects/${encodeURIComponent(project)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
  ]);
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
): Promise<string[]> {
  const host = getHost();
  const allPaths: string[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const res = await fetchWithRetry(
      `https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${perPage}&page=${page}`,
      { headers: apiHeaders() },
    );
    if (!res.ok) {
      if (shouldFallback(res.status) && isGlabAvailable()) {
        return listTreeViaCli(project, dirPath, ref);
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
): string[] {
  const allPaths: string[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const res = glabRun([
      'api',
      `projects/${encodeURIComponent(project)}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${perPage}&page=${page}`,
    ]);
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
  files: Map<string, string>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(baseDir, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(baseDir, full), fs.readFileSync(full, 'utf8'));
    }
  }
}

function extractArchive(
  buf: Buffer,
  dirPath: string,
): Map<string, string> | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scync-gl-'));
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

    const files = new Map<string, string>();
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
): Promise<Map<string, string> | null> {
  const host = getHost();
  const encodedProject = encodeURIComponent(project);
  const res = await fetchWithRetry(
    `https://${host}/api/v4/projects/${encodedProject}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`,
    { headers: apiHeaders() },
  );
  if (!res.ok) {
    if (shouldFallback(res.status) && isGlabAvailable()) {
      return fetchDirectoryViaArchiveViaCli(project, dirPath, ref);
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
): Map<string, string> | null {
  const encodedProject = encodeURIComponent(project);
  const result = spawnSync(
    'glab',
    [
      'api',
      `projects/${encodedProject}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`,
    ],
    { encoding: 'buffer' },
  );
  if (result.error || result.status !== 0 || !result.stdout?.length)
    return null;
  return extractArchive(result.stdout, dirPath);
}

export async function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
): Promise<GitLabResult> {
  const resolvedRef = await resolveRef(project, ref);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    (await detectPathType(project, normalizedPath, resolvedRef)) ===
      'directory';

  if (!isDirectory) {
    const content = await fetchFile(project, normalizedPath, resolvedRef);
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  // Directory — archive approach first (one API call), then fall back to per-file fetches
  const archived = await fetchDirectoryViaArchive(
    project,
    normalizedPath,
    resolvedRef,
  );
  if (archived) return { files: archived };

  const paths = await listTree(project, normalizedPath, resolvedRef);
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${project}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const files = new Map<string, string>();
  for (const p of paths) {
    files.set(
      path.relative(normalizedPath, p),
      await fetchFile(project, p, resolvedRef),
    );
  }
  return { files };
}
