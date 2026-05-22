/** Matches stable semver tags: vX.Y.Z or X.Y.Z (exactly three components). */
export const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+$/;

function parseSemver(tag: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Return the tag with the highest semver among the given list, or null if the list is empty or contains no semver tags. */
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
 * Parse a regex pattern from a ref string of the form `/pattern/` or `/pattern/flags`.
 * Returns the compiled RegExp, or null if the ref does not match that form.
 * Throws if the pattern body or flags are syntactically invalid.
 *
 * Supported subset (intentional differences from JS regex literal syntax):
 * - The pattern body must be non-empty: `//` is not recognised and returns null
 *   (treated as a literal ref, since an empty pattern is not useful for tag matching).
 * - The closing `/` is the last `/` in the string, so inner unescaped slashes are
 *   absorbed into the pattern body (e.g. `/foo/bar/` → pattern `foo/bar`).
 * - Stateful flags `g` and `y` are silently stripped because callers use `.test()`.
 * - Any other unrecognised flags cause `new RegExp()` to throw a descriptive error.
 */
export function parseRefPattern(ref: string): RegExp | null {
  const m = /^\/(.+)\/([A-Za-z]*)$/.exec(ref);
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
