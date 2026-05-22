import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verbose } from '../logger';
import {
  isLatestSentinel,
  isRecentSentinel,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../ref';

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
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(base, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(base, full), fs.readFileSync(full));
    }
  }
}

function redactGitUrl(url: string): string {
  return (
    url
      // URL-style: scheme://user:pass@host/...
      .replace(/(\/\/)[^@]*@/, '$1***@')
      // SCP-style with password: user:pass@host:path (only when userinfo contains ':')
      .replace(/^[^/:@\s]+:[^/:@\s]+@/, '***@')
  );
}

export function isGitRemoteUrl(s: string): boolean {
  return (
    s.startsWith('git+ssh://') ||
    s.startsWith('git://') ||
    s.startsWith('ssh://')
  );
}

export function parseGitRemoteSpec(spec: string): {
  repo: string;
  file: string;
  ref: string | undefined;
} {
  if (!isGitRemoteUrl(spec)) {
    throw new Error(
      `Invalid git URL spec "${spec}". Supported schemes: git+ssh://, git://, ssh://`,
    );
  }
  const schemeEnd = spec.indexOf('://') + 3;
  const separatorIdx = spec.indexOf('//', schemeEnd);
  if (separatorIdx === -1 || separatorIdx <= schemeEnd) {
    throw new Error(
      `Invalid git URL spec "${spec}". Expected format: <remote-url>//<file-path>[@ref], e.g. git+ssh://git@host/org/repo.git//path/to/file.yml@main (supported schemes: git+ssh://, git://, ssh://)`,
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

function resolveGitRef(repo: string, ref: string): string {
  const pattern = parseRefPattern(ref);
  const wantSemver = isLatestSentinel(ref);
  const wantRecent = isRecentSentinel(ref);
  if (!wantSemver && !wantRecent && !pattern) return ref;

  verbose(`git: listing remote tags for ${redactGitUrl(repo)}`);
  // $latest: sort by version (semver-aware); $recent/pattern: sort by creation date
  const sortArg = wantSemver
    ? '--sort=-version:refname'
    : '--sort=-creatordate';
  const result = run('git', [
    'ls-remote',
    '--tags',
    sortArg,
    repo,
    'refs/tags/*^{}',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Failed to list tags for ${redactGitUrl(repo)}: ${result.stderr.trim()}`,
    );
  }
  const names = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const ref = line.split('\t')[1] ?? '';
      return ref.replace(/^refs\/tags\//, '').replace(/\^{}$/, '');
    })
    .filter(Boolean);

  const filterFn = pattern
    ? (n: string) => pattern.test(n)
    : wantSemver
      ? (n: string) => SEMVER_PATTERN.test(n)
      : () => true;

  const found = names.find(filterFn);
  if (found) return found;

  if (wantSemver)
    throw new Error(
      `No semver tags found for ${redactGitUrl(repo)} (needed to resolve $latest)`,
    );
  if (wantRecent)
    throw new Error(
      `No tags found for ${redactGitUrl(repo)} (needed to resolve $recent)`,
    );
  throw new Error(`No tags matching "${ref}" found for ${redactGitUrl(repo)}`);
}

export function fetchGit(repo: string, file: string, ref?: string): GitResult {
  const normalized = path.normalize(file);
  if (
    path.isAbsolute(file) ||
    normalized === '..' ||
    normalized.startsWith('..' + path.sep)
  ) {
    throw new Error(`Unsafe file path escapes repository root: ${file}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-git-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');

    const resolvedRef =
      ref &&
      (isLatestSentinel(ref) || isRecentSentinel(ref) || parseRefPattern(ref))
        ? resolveGitRef(repo, ref)
        : ref;

    if (!resolvedRef || !looksLikeCommitHash(resolvedRef)) {
      const args = ['clone', '--depth', '1'];
      if (resolvedRef) args.push('--branch', resolvedRef);
      verbose(`git ${args.join(' ')} ${redactGitUrl(repo)} <tmpdir>`);
      args.push(repo, repoDir);
      const res = run('git', args);
      if (res.status !== 0) {
        throw new Error(`git clone failed: ${res.stderr.trim()}`);
      }
    } else {
      verbose(`git clone ${redactGitUrl(repo)} <tmpdir>`);
      const cloneRes = run('git', ['clone', repo, repoDir]);
      if (cloneRes.status !== 0) {
        throw new Error(`git clone failed: ${cloneRes.stderr.trim()}`);
      }
      verbose(`git checkout ${resolvedRef}`);
      const checkoutRes = run('git', ['checkout', resolvedRef], {
        cwd: repoDir,
      });
      if (checkoutRes.status !== 0) {
        throw new Error(
          `git checkout ${resolvedRef} failed: ${checkoutRes.stderr.trim()}`,
        );
      }
    }

    const normalizedFile = file.replace(/\/$/, '');
    const fullPath = path.join(repoDir, normalizedFile);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Path not found in repository: ${file}`);
    }

    const realRepoDir = fs.realpathSync(repoDir);
    const realFullPath = fs.realpathSync(fullPath);
    if (
      realFullPath !== realRepoDir &&
      !realFullPath.startsWith(realRepoDir + path.sep)
    ) {
      throw new Error(
        `Unsafe file path escapes repository root via symlink: ${file}`,
      );
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
