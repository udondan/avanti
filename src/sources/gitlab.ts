import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitLabResult {
  /** Map of relative path → content */
  files: Map<string, string>;
}

function glabRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('glab', args, { encoding: 'utf8' });
  if (result.error) {
    const msg = result.error.message ?? '';
    if (msg.includes('ENOENT')) {
      throw new Error(
        'glab CLI not found. Install it from https://gitlab.com/gitlab-org/cli',
      );
    }
    throw new Error(`glab error: ${msg}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function resolveRef(project: string, ref: string | undefined): string {
  if (!ref || ref === '$latest') {
    const res = glabRun([
      'api',
      `projects/${encodeURIComponent(project)}/repository/tags?order_by=version&sort=desc&per_page=1`,
    ]);
    if (res.status !== 0) {
      throw new Error(
        `Failed to resolve $latest for ${project}: ${res.stderr}`,
      );
    }
    const tags = JSON.parse(res.stdout) as Array<{ name: string }>;
    if (!tags.length) {
      throw new Error(
        `No tags found for ${project} (needed to resolve $latest)`,
      );
    }
    return tags[0].name;
  }
  return ref;
}

function fetchFile(project: string, filePath: string, ref: string): string {
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

function listTree(project: string, dirPath: string, ref: string): string[] {
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

function detectPathType(
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

// Downloads the directory as a tar.gz archive (one API call) and extracts it locally.
// Returns null if the archive approach fails, so the caller can fall back.
function fetchDirectoryViaArchive(
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scync-gl-'));
  try {
    const archivePath = path.join(tmpDir, 'archive.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.writeFileSync(archivePath, result.stdout);
    fs.mkdirSync(extractDir);

    const tarResult = spawnSync(
      'tar',
      ['-xzf', archivePath, '-C', extractDir],
      {
        encoding: 'utf8',
      },
    );
    if (tarResult.status !== 0) return null;

    // The archive root is a single dir with a dynamic name (project-ref-sha/)
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

export function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
): GitLabResult {
  const resolvedRef = resolveRef(project, ref);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    detectPathType(project, normalizedPath, resolvedRef) === 'directory';

  if (!isDirectory) {
    const content = fetchFile(project, normalizedPath, resolvedRef);
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  // Directory — archive approach first (one API call), then fall back to per-file fetches
  const archived = fetchDirectoryViaArchive(
    project,
    normalizedPath,
    resolvedRef,
  );
  if (archived) return { files: archived };

  const paths = listTree(project, normalizedPath, resolvedRef);
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${project}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const files = new Map<string, string>();
  for (const p of paths) {
    files.set(
      path.relative(normalizedPath, p),
      fetchFile(project, p, resolvedRef),
    );
  }
  return { files };
}
