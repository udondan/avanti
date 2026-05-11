export function isBinary(buf: Buffer): boolean {
  // Mirror git's heuristic: if any of the first 8000 bytes is a NUL byte, treat as binary.
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
