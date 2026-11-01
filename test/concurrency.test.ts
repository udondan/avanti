import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/concurrency';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const res = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(res).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` calls at once', async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
      },
    );
    expect(peak).toBe(4);
  });

  it('returns an empty array for no items', async () => {
    expect(
      await mapWithConcurrency([], 4, (n: number) => Promise.resolve(n)),
    ).toEqual([]);
  });

  it('rejects with the first error and starts no new calls after it', async () => {
    // Two workers: item 1 fails while item 2 is still running. When item 2
    // finishes, its worker must not pick up item 3.
    const started: number[] = [];
    let finishSecond: () => void = () => {};
    const run = mapWithConcurrency([1, 2, 3, 4, 5], 2, (n) => {
      started.push(n);
      if (n === 1) return Promise.reject(new Error('boom'));
      if (n === 2)
        return new Promise<number>((r) => {
          finishSecond = () => r(n);
        });
      return Promise.resolve(n);
    });

    await expect(run).rejects.toThrow('boom');
    finishSecond();
    await tick();
    expect(started).toEqual([1, 2]);
  });
});
