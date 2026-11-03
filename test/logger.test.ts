import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVerbose, setVerbose, verbose } from '../src/logger';

describe('logger', () => {
  afterEach(() => {
    setVerbose(false);
    vi.restoreAllMocks();
  });

  it('writes verbose messages to stderr only when enabled', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(isVerbose()).toBe(false);
    verbose('hidden');
    expect(write).not.toHaveBeenCalled();

    setVerbose(true);
    expect(isVerbose()).toBe(true);
    verbose('shown');
    expect(write).toHaveBeenCalledWith('[verbose] shown\n');
  });
});
