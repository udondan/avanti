/** Matches stable semver tags: vX.Y.Z or X.Y.Z (exactly three components). */
export const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+$/;

export function isLatestSentinel(ref: string | undefined): boolean {
  return ref === '$latest';
}

export function isRecentSentinel(ref: string | undefined): boolean {
  return ref === '$recent';
}

/**
 * Parse a JS regex literal (/pattern/ or /pattern/flags) from a ref string.
 * Returns the compiled RegExp, or null if the ref is not a regex literal.
 * Throws if the pattern is syntactically invalid.
 */
export function parseRefPattern(ref: string): RegExp | null {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(ref);
  if (!m) return null;
  // Strip stateful flags (g=global, y=sticky) — callers use .test() in loops
  const flags = m[2].replace(/[gy]/g, '') || undefined;
  try {
    return new RegExp(m[1], flags);
  } catch (e) {
    throw new Error(`Invalid ref pattern "${ref}": ${(e as Error).message}`, {
      cause: e,
    });
  }
}
