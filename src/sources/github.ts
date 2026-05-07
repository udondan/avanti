import { spawnSync } from 'child_process';
import * as path from 'path';

export interface GitHubResult {
  files: Map<string, string>;
}

function ghRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) {
    const msg = result.error.message ?? '';
    if (msg.includes('ENOENT')) {
      throw new Error(
        'gh CLI not found. Install it from https://cli.github.com',
      );
    }
    throw new Error(`gh error: ${msg}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function detectPathType(
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

function fetchFile(repo: string, filePath: string, ref: string): string {
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

function listTree(repo: string, dirPath: string, ref: string): string[] {
  const res = ghRun([
    'api',
    `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    '--jq',
    `.tree[] | select(.type == "blob") | select(.path | startswith("${dirPath}/")) | .path`,
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Failed to list tree ${dirPath} in ${repo}@${ref}: ${res.stderr}`,
    );
  }
  return res.stdout.trim().split('\n').filter(Boolean);
}

export function fetchGitHub(
  repo: string,
  file: string,
  ref: string | undefined,
): GitHubResult {
  const resolvedRef = ref ?? 'HEAD';
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    detectPathType(repo, normalizedPath, resolvedRef) === 'directory';

  if (!isDirectory) {
    const content = fetchFile(repo, normalizedPath, resolvedRef);
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  const paths = listTree(repo, normalizedPath, resolvedRef);
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${repo}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const files = new Map<string, string>();
  for (const p of paths) {
    files.set(
      path.relative(normalizedPath, p),
      fetchFile(repo, p, resolvedRef),
    );
  }
  return { files };
}
