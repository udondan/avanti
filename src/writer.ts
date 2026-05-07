import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface WriteTarget {
  targetPath: string;
  content: string;
  mode?: string;
}

export function atomicWrite(targets: WriteTarget[]): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fileferry-"));
  try {
    // Stage all files to temp dir first
    const staged: Array<{ tmp: string; dest: string; mode?: string }> = [];
    for (const t of targets) {
      const tmpFile = path.join(
        tmpDir,
        path.basename(t.targetPath) + "-" + staged.length,
      );
      fs.writeFileSync(tmpFile, t.content, "utf8");
      staged.push({ tmp: tmpFile, dest: t.targetPath, mode: t.mode });
    }

    // All staging succeeded — now write to real targets
    for (const s of staged) {
      const dir = path.dirname(s.dest);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.copyFileSync(s.tmp, s.dest);
      if (s.mode) {
        fs.chmodSync(s.dest, parseInt(s.mode, 8));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
