import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface S3Result {
  files: Map<string, Buffer>;
}

function awsRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('aws', args, { encoding: 'utf8' });
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
  files: Map<string, Buffer>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(base, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(base, full), fs.readFileSync(full));
    }
  }
}

export function fetchS3(uri: string): S3Result {
  const isDir = uri.endsWith('/');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-s3-'));
  try {
    if (!isDir) {
      let filename: string;
      try {
        filename = path.basename(new URL(uri).pathname) || 'download';
      } catch {
        filename = path.basename(uri) || 'download';
      }
      // Download to a temp file to support binary content
      const tmpFile = path.join(tmpDir, filename);
      const res = awsRun(['s3', 'cp', uri, tmpFile]);
      if (res.status !== 0) {
        throw new Error(`Failed to fetch ${uri}: ${res.stderr.trim()}`);
      }
      return { files: new Map([[filename, fs.readFileSync(tmpFile)]]) };
    }

    const res = awsRun(['s3', 'sync', uri, tmpDir]);
    if (res.status !== 0) {
      throw new Error(`Failed to sync ${uri}: ${res.stderr.trim()}`);
    }
    const files = new Map<string, Buffer>();
    collectFiles(tmpDir, tmpDir, files);
    return { files };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
