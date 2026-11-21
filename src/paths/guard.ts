import * as path from 'path';

// Windows paths are case-insensitive and may use either slash style.
export function normalizePath(p: string): string {
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\').toLowerCase();
  }
  return p;
}

export function assertWithinWorkingDir(
  resolvedPath: string,
  workingDir: string,
): void {
  const normResolved = normalizePath(resolvedPath);
  const normWorkingDir = normalizePath(workingDir);
  const prefix = normWorkingDir.endsWith(path.sep)
    ? normWorkingDir
    : normWorkingDir + path.sep;
  if (normResolved !== normWorkingDir && !normResolved.startsWith(prefix)) {
    throw new Error(
      `Target path "${resolvedPath}" escapes working directory "${workingDir}".`,
    );
  }
}
