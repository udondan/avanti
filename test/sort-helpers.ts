/** Comparator matching the default Array#sort order (UTF-16 code units). */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
