// How many files of a directory are downloaded at the same time. Sending all
// requests at once makes hosts like GitLab.com answer with 429 for large
// directories (see #516).
export const DIRECTORY_FETCH_CONCURRENCY = 6;

// Like Promise.all(items.map(fn)), but runs at most `limit` calls at a time.
// Results keep the order of `items`. After the first failure no new calls
// start, and the returned promise rejects with that error.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
