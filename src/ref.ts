/** Matches stable semver tags: vX.Y.Z or X.Y.Z (exactly three components). */
export const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+$/;

function parseSemver(tag: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Return the tag with the highest semver among the given list, or null if empty. */
export function maxSemverTag(tags: string[]): string | null {
  const valid = tags.filter((t) => SEMVER_PATTERN.test(t));
  if (!valid.length) return null;
  return valid.reduce((best, tag) => {
    const [bMaj, bMin, bPatch] = parseSemver(best);
    const [tMaj, tMin, tPatch] = parseSemver(tag);
    if (tMaj !== bMaj) return tMaj > bMaj ? tag : best;
    if (tMin !== bMin) return tMin > bMin ? tag : best;
    return tPatch > bPatch ? tag : best;
  });
}

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
