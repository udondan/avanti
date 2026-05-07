import * as fs from 'fs';
import * as path from 'path';

export interface LocalResult {
  files: Map<string, string>;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(process.env['HOME'] ?? '~', p.slice(2));
  }
  return p;
}

export function fetchLocal(src: string): LocalResult {
  const resolved = expandHome(src);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Local source not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  const files = new Map<string, string>();
  if (stat.isDirectory()) {
    readDirRecursive(resolved, resolved, files);
  } else {
    files.set(path.basename(resolved), fs.readFileSync(resolved, 'utf8'));
  }
  return { files };
}

function readDirRecursive(
  base: string,
  current: string,
  out: Map<string, string>,
): void {
  for (const entry of fs.readdirSync(current)) {
    const full = path.join(current, entry);
    const rel = path.relative(base, full);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      readDirRecursive(base, full, out);
    } else {
      out.set(rel, fs.readFileSync(full, 'utf8'));
    }
  }
}
