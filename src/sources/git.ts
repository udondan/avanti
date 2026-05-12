import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitResult {
  files: Map<string, Buffer>;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd });
  if (result.error) throw new Error(`${cmd} error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function looksLikeCommitHash(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
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

export function isGitSshUrl(s: string): boolean {
  return (
    s.startsWith('git+ssh://') ||
    s.startsWith('git://') ||
    s.startsWith('ssh://')
  );
}

export function parseGitSshSpec(spec: string): {
  repo: string;
  file: string;
  ref: string | undefined;
} {
  const schemeEnd = spec.indexOf('://') + 3;
  const separatorIdx = spec.indexOf('//', schemeEnd);
  if (separatorIdx === -1) {
    throw new Error(
      `Invalid git URL spec "${spec}". Expected: git+ssh://git@host/org/repo.git//path/to/file.yml[@ref]`,
    );
  }
  const repo = spec.slice(0, separatorIdx);
  const rest = spec.slice(separatorIdx + 2);
  const atIdx = rest.lastIndexOf('@');
  const file = atIdx === -1 ? rest : rest.slice(0, atIdx);
  const ref = atIdx === -1 ? undefined : rest.slice(atIdx + 1);
  if (!file) {
    throw new Error(
      `Invalid git URL spec "${spec}". File path is required after //`,
    );
  }
  return { repo, file, ref };
}

export function fetchGit(repo: string, file: string, ref?: string): GitResult {
  if (path.isAbsolute(file) || path.normalize(file).startsWith('..')) {
    throw new Error(`Unsafe file path escapes repository root: ${file}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-git-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');

    if (!ref || !looksLikeCommitHash(ref)) {
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      args.push(repo, repoDir);
      const res = run('git', args);
      if (res.status !== 0) {
        throw new Error(`git clone failed: ${res.stderr.trim()}`);
      }
    } else {
      const cloneRes = run('git', ['clone', repo, repoDir]);
      if (cloneRes.status !== 0) {
        throw new Error(`git clone failed: ${cloneRes.stderr.trim()}`);
      }
      const checkoutRes = run('git', ['checkout', ref], { cwd: repoDir });
      if (checkoutRes.status !== 0) {
        throw new Error(
          `git checkout ${ref} failed: ${checkoutRes.stderr.trim()}`,
        );
      }
    }

    const normalizedFile = file.replace(/\/$/, '');
    const fullPath = path.join(repoDir, normalizedFile);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Path not found in repository: ${file}`);
    }

    const files = new Map<string, Buffer>();
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() || file.endsWith('/')) {
      collectFiles(fullPath, fullPath, files);
      if (!files.size) {
        throw new Error(`Empty directory: ${file}`);
      }
    } else {
      files.set(path.basename(normalizedFile), fs.readFileSync(fullPath));
    }
    return { files };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
