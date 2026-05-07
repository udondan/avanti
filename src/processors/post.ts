import { spawnSync } from "child_process";

export function applyPost(content: string, script: string): string {
  const result = spawnSync("sh", ["-c", script], {
    input: content,
    encoding: "utf8",
  });
  if (result.status !== null && result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(
      `post script exited with code ${result.status}${stderr ? ": " + stderr : ""}`,
    );
  }
  if (result.error) {
    throw new Error(`post script failed to spawn: ${result.error.message}`);
  }
  return result.stdout;
}
