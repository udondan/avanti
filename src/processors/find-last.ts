/** Index of the last item matching `predicate`, searching back from `from`. */
export function findLastIndex<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  from = items.length - 1,
): number {
  for (let j = from; j >= 0; j--) {
    if (predicate(items[j])) return j;
  }
  return -1;
}
