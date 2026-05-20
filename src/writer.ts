import * as fs from 'fs';
import * as path from 'path';

export interface WriteTarget {
  targetPath: string;
  content: Buffer;
  mode?: string;
  backupPath?: string;
}

export function atomicWrite(
  targets: WriteTarget[],
  deletions: string[] = [],
): void {
  // Stage each file as a sibling temp file on the same filesystem as the
  // destination so that renameSync (rename(2)) is atomic on POSIX.
  const staged: Array<{ tmp: string; dest: string; effectiveMode?: number }> =
    [];
  const backupTemps: string[] = [];
  try {
    for (const t of targets) {
      if (t.backupPath && fs.existsSync(t.targetPath)) {
        const backupDir = path.dirname(t.backupPath);
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }
        // Copy via a temp file then rename so that a symlink at backupPath is
        // replaced (not followed), preventing writes outside allowed roots.
        const backupTmp = path.join(
          backupDir,
          '.' + path.basename(t.backupPath) + '.avanti-tmp',
        );
        backupTemps.push(backupTmp);
        fs.copyFileSync(t.targetPath, backupTmp);
        fs.renameSync(backupTmp, t.backupPath);
      }

      const dir = path.dirname(t.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = path.join(
        dir,
        '.' + path.basename(t.targetPath) + '.avanti-tmp',
      );
      fs.writeFileSync(tmpFile, t.content);

      // Resolve the effective mode: explicit config value wins; otherwise
      // preserve the existing file's full permission bits (0o7777) so rename(2)
      // doesn't silently reset them to the umask default. New files get the
      // OS umask default.
      let effectiveMode: number | undefined;
      if (t.mode) {
        effectiveMode = parseInt(t.mode, 8);
      } else {
        try {
          effectiveMode = fs.statSync(t.targetPath).mode & 0o7777;
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
    for (const tmp of backupTemps) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // already renamed into place or never created
      }
    }
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
      console.warn(
        `Warning: could not delete ${p}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
