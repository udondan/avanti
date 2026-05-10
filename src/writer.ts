import * as fs from 'fs';
import * as path from 'path';

export interface WriteTarget {
  targetPath: string;
  content: string;
  mode?: string;
}

export function atomicWrite(
  targets: WriteTarget[],
  deletions: string[] = [],
): void {
  // Stage each file as a sibling temp file on the same filesystem as the
  // destination so that renameSync (rename(2)) is atomic on POSIX.
  const staged: Array<{ tmp: string; dest: string; effectiveMode?: number }> =
    [];
  try {
    for (const t of targets) {
      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = path.join(
        dir,
        '.' + path.basename(t.targetPath) + '.avanti-tmp',
      );
      fs.writeFileSync(tmpFile, t.content, 'utf8');

      // Resolve the effective mode: explicit config value wins; otherwise
      // preserve the existing file's permissions so rename(2) doesn't silently
      // drop custom modes. New files get the OS umask default.
      let effectiveMode: number | undefined;
      if (t.mode) {
        effectiveMode = parseInt(t.mode, 8);
      } else {
        try {
          effectiveMode = fs.statSync(t.targetPath).mode & 0o777;
        } catch {
          // file doesn't exist yet — leave the temp file's umask permissions
        }
      }

      staged.push({ tmp: tmpFile, dest: t.targetPath, effectiveMode });
    }

    // All staging succeeded — atomically rename each temp file into place
    for (const s of staged) {
      fs.renameSync(s.tmp, s.dest);
      if (s.effectiveMode !== undefined) {
        fs.chmodSync(s.dest, s.effectiveMode);
      }
    }
  } finally {
    for (const s of staged) {
      try {
        fs.rmSync(s.tmp, { force: true });
      } catch {
        // already renamed into place or never created
      }
    }
  }

  // Deletions happen after writes succeed; each failure is non-fatal
  for (const p of deletions) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.warn(`Warning: could not delete ${p}: ${(err as Error).message}`);
    }
  }
}
