import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verbose } from '../logger';
import { expandTilde } from '../paths';
import { resolveVars } from '../variables';
import type { Variables } from '../types';

export interface LocalResult {
  files: Map<string, Buffer>;
  missing?: boolean;
}

export function fetchLocal(
  src: string,
  workingDir: string,
  optional = false,
): LocalResult {
  let resolved: string;
  if (src.startsWith('~/')) {
    resolved = path.join(os.homedir(), src.slice(2));
  } else if (path.isAbsolute(src)) {
    resolved = src;
  } else {
    resolved = path.resolve(workingDir, src);
  }
  verbose(`local: reading ${resolved}`);

  if (!fs.existsSync(resolved)) {
    if (optional) return { files: new Map(), missing: true };
    throw new Error(`Local source not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  const files = new Map<string, Buffer>();
  if (stat.isDirectory()) {
    readDirRecursive(resolved, resolved, files);
  } else {
    files.set(path.basename(resolved), fs.readFileSync(resolved));
  }
  return { files };
}

function readDirRecursive(
  base: string,
  current: string,
  out: Map<string, Buffer>,
): void {
  for (const entry of fs.readdirSync(current)) {
    const full = path.join(current, entry);
    const rel = path.relative(base, full);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      readDirRecursive(base, full, out);
    } else {
      out.set(rel, fs.readFileSync(full));
    }
  }
}

export function resolveSymlinkSrcPath(
  src: string,
  workingDir: string,
  vars: Variables,
  mode: boolean | 'absolute' | 'relative',
  linkPath: string,
): string {
  const expanded = resolveVars(src, vars);
  // Guard against a variable that resolves to a remote URL or exec: expression.
  // Config-level validation (isLocalFileSrc) checks the raw src before variable
  // substitution; a variable value could still expand to a remote spec.
  if (
    expanded.startsWith('http://') ||
    expanded.startsWith('https://') ||
    expanded.startsWith('exec:') ||
    expanded.startsWith('git://') ||
    expanded.startsWith('git+') ||
    expanded.startsWith('ssh://') ||
    expanded.startsWith('s3://') ||
    expanded.startsWith('github:') ||
    expanded.startsWith('gitlab:') ||
    expanded.startsWith('raw:')
  ) {
    throw new Error(
      `symlink src resolved to a non-local value "${expanded}"; symlink src must be a local filesystem path`,
    );
  }
  const tildeExpanded = expandTilde(expanded);
  const abs = path.isAbsolute(tildeExpanded)
    ? tildeExpanded
    : path.resolve(workingDir, expanded);
  if (mode === 'relative') {
    const rel = path.relative(path.dirname(linkPath), abs);
    // path.relative returns "" when both paths are identical (src is the
    // symlink's parent directory). Normalize to "." so the symlink target is
    // valid — a symlink with an empty target string is broken on all platforms.
    return rel === '' ? '.' : rel;
  }
  return abs;
}
