import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface S3Result {
  files: Map<string, string>;
}

function awsRun(
  args: string[],
  opts: { encoding: 'utf8' | 'buffer' } = { encoding: 'utf8' },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('aws', args, {
    encoding: opts.encoding as 'utf8',
  });
  if (result.error) throw new Error(`aws CLI error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function collectFiles(
  base: string,
  dir: string,
  files: Map<string, string>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(base, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(base, full), fs.readFileSync(full, 'utf8'));
    }
  }
}

export function fetchS3(uri: string): S3Result {
  const isDir = uri.endsWith('/');

  if (!isDir) {
    const res = awsRun(['s3', 'cp', uri, '-']);
    if (res.status !== 0) {
      throw new Error(`Failed to fetch ${uri}: ${res.stderr.trim()}`);
    }
    let filename: string;
    try {
      filename = path.basename(new URL(uri).pathname) || 'download';
    } catch {
      filename = path.basename(uri) || 'download';
    }
    return { files: new Map([[filename, res.stdout]]) };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scync-s3-'));
  try {
    const res = awsRun(['s3', 'sync', uri, tmpDir]);
    if (res.status !== 0) {
      throw new Error(`Failed to sync ${uri}: ${res.stderr.trim()}`);
    }
    const files = new Map<string, string>();
    collectFiles(tmpDir, tmpDir, files);
    return { files };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
