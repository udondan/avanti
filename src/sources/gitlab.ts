import { spawnSync } from 'child_process';
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
  const res = glabRun([
    'api',
    `projects/${encodeURIComponent(project)}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=100`,
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Failed to list tree ${dirPath} in ${project}@${ref}: ${res.stderr}`,
    );
  }
  const items = JSON.parse(res.stdout) as Array<{ type: string; path: string }>;
  return items.filter((i) => i.type === 'blob').map((i) => i.path);
}

export function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
): GitLabResult {
  const resolvedRef = resolveRef(project, ref);
  const files = new Map<string, string>();

  try {
    const content = fetchFile(project, file, resolvedRef);
    files.set(path.basename(file), content);
  } catch {
    // Try as directory
    const paths = listTree(project, file, resolvedRef);
    if (!paths.length) {
      throw new Error(
        `Failed to fetch ${file} from ${project}@${resolvedRef} (not a file or empty directory)`,
      );
    }
    for (const p of paths) {
      const rel = path.relative(file, p);
      const content = fetchFile(project, p, resolvedRef);
      files.set(rel, content);
    }
  }

  return { files };
}
