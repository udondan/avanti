import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verbose } from '../logger';

export interface LocalResult {
  files: Map<string, Buffer>;
  missing?: boolean;
}

export function fetchLocal(
  src: string,
  workingDir: string,
  optional = false,
  pendingWrites?: Map<string, Buffer>,
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

  if (pendingWrites !== undefined) {
    if (pendingWrites.has(resolved)) {
      return {
        files: new Map([
          [path.basename(resolved), pendingWrites.get(resolved)!],
        ]),
      };
    }
    const prefix = resolved + path.sep;
    const dirEntries = [...pendingWrites.entries()].filter(([k]) =>
      k.startsWith(prefix),
    );
    if (dirEntries.length > 0) {
      const files = new Map<string, Buffer>();
      for (const [abs, content] of dirEntries) {
        files.set(path.relative(resolved, abs), content);
      }
      return { files };
    }
  }

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
