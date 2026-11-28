/**
 * Compares strings by UTF-16 code units, the order `Array.prototype.sort()`
 * uses without a comparator.
 */
export function compareCodeUnits(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}
