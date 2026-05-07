import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch } from "diff";
import chalk from "chalk";

export interface FileDiff {
  targetPath: string;
  isNew: boolean;
  hasChanges: boolean;
  patch: string;
}

export function computeDiff(targetPath: string, newContent: string): FileDiff {
  const isNew = !fs.existsSync(targetPath);
  const oldContent = isNew ? "" : fs.readFileSync(targetPath, "utf8");

  const hasChanges = oldContent !== newContent;

  const patch = createTwoFilesPatch(
    isNew ? "/dev/null" : targetPath,
    targetPath,
    oldContent,
    newContent,
    isNew ? "" : undefined,
    isNew ? "new file" : undefined,
  );

  return { targetPath, isNew, hasChanges, patch };
}

export function formatDiff(diff: FileDiff): string {
  if (!diff.hasChanges) return "";

  const lines = diff.patch.split("\n");
  const colored = lines.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---"))
      return chalk.bold(line);
    if (line.startsWith("@@")) return chalk.cyan(line);
    if (line.startsWith("+")) return chalk.green(line);
    if (line.startsWith("-")) return chalk.red(line);
    return line;
  });
  return colored.join("\n");
}

export function printDiffs(diffs: FileDiff[]): void {
  const changed = diffs.filter((d) => d.hasChanges);
  if (!changed.length) {
    console.log("No changes.");
    return;
  }
  for (const d of changed) {
    console.log(formatDiff(d));
  }
}

export function resolveTargetPath(
  entry: { target?: string },
  relPath: string,
  baseDir: string,
): string {
  if (entry.target) {
    // If target looks like a directory (ends with /) or the relPath has subdirs, join them
    if (entry.target.endsWith("/") || entry.target.endsWith(path.sep)) {
      return path.resolve(baseDir, entry.target, relPath);
    }
    // Single file: use target directly
    return path.resolve(baseDir, entry.target);
  }
  return path.resolve(baseDir, relPath);
}
