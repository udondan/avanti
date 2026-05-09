import * as fs from 'fs';
import * as path from 'path';

export interface LocalResult {
  files: Map<string, string>;
}

export function fetchLocal(
  src: string,
  workingDir: string,
  optional = false,
): LocalResult {
  let resolved: string;
  if (src.startsWith('~/')) {
    const home = process.env['HOME'];
    if (!home) {
      throw new Error(
        `Cannot expand '~/' in source '${src}': HOME environment variable is not set`,
      );
    }
    resolved = path.join(home, src.slice(2));
  } else if (path.isAbsolute(src)) {
    resolved = src;
  } else {
    resolved = path.resolve(workingDir, src);
  }
  if (!fs.existsSync(resolved)) {
    if (optional) return { files: new Map() };
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
