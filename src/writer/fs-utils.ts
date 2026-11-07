/** Small filesystem primitives shared by the unprivileged write phases. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Returns the platform's value of an open(2) flag, or 0 where it is not
// available (e.g. O_NOFOLLOW / O_NONBLOCK on Windows).
export function openFlag(name: 'O_NOFOLLOW' | 'O_NONBLOCK'): number {
  return (fs.constants as Record<string, number>)[name] ?? 0;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Writes all of content to fd, looping over short writes.
export function writeAll(fd: number, content: Buffer): void {
  let written = 0;
  while (written < content.length) {
    written += fs.writeSync(fd, content, written, content.length - written);
  }
}

// A hidden, randomly-named sibling path: <dir>/.<baseName>.<random><suffix>.
export function randomTempPath(
  dir: string,
  baseName: string,
  suffix: string,
): string {
  return path.join(
    dir,
    '.' + baseName + '.' + crypto.randomBytes(8).toString('hex') + suffix,
  );
}

// Calls create with fresh random temp paths until one does not collide
// (EEXIST) and returns the created path. Any other error is rethrown.
export function createUniqueTemp(
  dir: string,
  baseName: string,
  suffix: string,
  create: (tmpPath: string) => void,
): string {
  for (;;) {
    const tmpPath = randomTempPath(dir, baseName, suffix);
    try {
      create(tmpPath);
      return tmpPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

// Removes each path, ignoring failures.
export function removeQuietly(paths: Iterable<string>): void {
  for (const p of paths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // already renamed into place or never created
    }
  }
}
