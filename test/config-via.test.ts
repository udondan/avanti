import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/sources/github', () => ({
  fetchGitHub: vi.fn(),
}));

vi.mock('../src/sources/gitlab', () => ({
  fetchGitLab: vi.fn(),
}));

import { fetchGitHub } from '../src/sources/github';
import { fetchGitLab } from '../src/sources/gitlab';
import { loadConfig } from '../src/config';
import type { MockInstance } from 'vitest';

const mockFetchGitHub = fetchGitHub as unknown as MockInstance;
const mockFetchGitLab = fetchGitLab as unknown as MockInstance;

const MINIMAL_CONFIG = Buffer.from('files:\n  out.txt:\n    src: local/path\n');

describe('loadConfig — via forwarding to remote fetchers', () => {
  beforeEach(() => {
    mockFetchGitHub.mockResolvedValue({
      files: new Map([['config.yml', MINIMAL_CONFIG]]),
    });
    mockFetchGitLab.mockResolvedValue({
      files: new Map([['config.yml', MINIMAL_CONFIG]]),
    });
  });

  it('forwards via to fetchGitHub for github: config spec', async () => {
    await loadConfig('github:owner/repo:config.yml@main', 'cli');
    expect(mockFetchGitHub).toHaveBeenCalledWith(
      'owner/repo',
      'config.yml',
      'main',
      undefined,
      'cli',
    );
  });

  it('forwards via to fetchGitLab for gitlab: config spec', async () => {
    await loadConfig('gitlab:group/project:config.yml@main', 'cli');
    expect(mockFetchGitLab).toHaveBeenCalledWith(
      'group/project',
      'config.yml',
      'main',
      undefined,
      'cli',
    );
  });

  it('passes undefined via when not specified (uses fetcher default)', async () => {
    await loadConfig('github:owner/repo:config.yml@main');
    expect(mockFetchGitHub).toHaveBeenCalledWith(
      'owner/repo',
      'config.yml',
      'main',
      undefined,
      undefined,
    );
  });
});
