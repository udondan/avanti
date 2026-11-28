import * as os from 'os';
import * as path from 'path';
import { FileSrc, Variables } from '../types';
import { plainLocalPath, resolveLocalPathSrc } from './dispatch';

function localPathForSrc(
  src: FileSrc,
  vars: Variables,
  configBase: string | undefined,
): string | undefined {
  if (typeof src === 'string') return plainLocalPath(src, vars, configBase);
  if ('path' in src) return resolveLocalPathSrc(src.path, vars, configBase);
  return undefined;
}

function absolutePath(rawPath: string, workingDir: string): string {
  if (rawPath.startsWith('~/')) {
    return path.resolve(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(workingDir, rawPath);
}

function pendingWritesForPath(
  rawPath: string,
  workingDir: string,
  pendingWrites: Map<string, Buffer>,
): Map<string, Buffer> | null {
  const abs = absolutePath(rawPath, workingDir);
  const exact = pendingWrites.get(abs);
  if (exact !== undefined) {
    return new Map([[path.basename(abs), exact]]);
  }
  const prefix = abs + path.sep;
  const dirEntries = [...pendingWrites.entries()].filter(([k]) =>
    k.startsWith(prefix),
  );
  if (dirEntries.length === 0) return null;
  const files = new Map<string, Buffer>();
  for (const [absPath, content] of dirEntries) {
    files.set(path.relative(abs, absPath), content);
  }
  return files;
}

/**
 * Content a local source would resolve to once this run's pending writes are
 * applied, or `null` when the source is not a pending write target.
 */
export function pendingLocalFiles(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
  pendingWrites: Map<string, Buffer>,
  configBase?: string,
): Map<string, Buffer> | null {
  let rawPath: string | undefined;
  try {
    rawPath = localPathForSrc(src, vars, configBase);
  } catch {
    return null;
  }
  if (rawPath === undefined) return null;
  return pendingWritesForPath(rawPath, workingDir, pendingWrites);
}
