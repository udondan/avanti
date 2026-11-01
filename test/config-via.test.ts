import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/sources/github', () => ({
  fetchGitHub: vi.fn(),
}));

vi.mock('../src/sources/gitlab', () => ({
  fetchGitLab: vi.fn(),
}));

vi.mock('../src/sources/http', () => ({
  fetchHttp: vi.fn(),
}));

vi.mock('../src/sources/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/git')>()),
  fetchGit: vi.fn(),
}));

import { fetchGitHub } from '../src/sources/github';
import { fetchGitLab } from '../src/sources/gitlab';
import { fetchHttp } from '../src/sources/http';
import { fetchGit } from '../src/sources/git';
import { loadConfig } from '../src/config';
import type { MockInstance } from 'vitest';

const mockFetchGitHub = fetchGitHub as unknown as MockInstance;
const mockFetchGitLab = fetchGitLab as unknown as MockInstance;
const mockFetchHttp = fetchHttp as unknown as MockInstance;
const mockFetchGit = fetchGit as unknown as MockInstance;

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

describe('loadConfig — remote config content', () => {
  const twoFiles = {
    files: new Map([
      ['a.yml', MINIMAL_CONFIG],
      ['b.yml', MINIMAL_CONFIG],
    ]),
  };

  it('loads a config over http(s)', async () => {
    mockFetchHttp.mockResolvedValue(MINIMAL_CONFIG);
    const cfg = await loadConfig('https://example.com/avanti.yml');
    expect(mockFetchHttp).toHaveBeenCalledWith(
      'https://example.com/avanti.yml',
    );
    expect(Object.keys(cfg.files)).toEqual(['out.txt']);
  });

  it('loads a config from a git remote URL', async () => {
    mockFetchGit.mockReturnValue({
      files: new Map([['config.yml', MINIMAL_CONFIG]]),
    });
    const cfg = await loadConfig(
      'git+ssh://git@example.com/org/repo.git//config.yml@v1',
    );
    expect(mockFetchGit).toHaveBeenCalledWith(
      'git+ssh://git@example.com/org/repo.git',
      'config.yml',
      'v1',
    );
    expect(Object.keys(cfg.files)).toEqual(['out.txt']);
  });

  it('rejects a github: config that resolves to several files', async () => {
    mockFetchGitHub.mockResolvedValue(twoFiles);
    await expect(loadConfig('github:owner/repo:dir@main')).rejects.toThrow(
      'Remote config must be a single file, got 2 files from "github:owner/repo:dir@main"',
    );
  });

  it('rejects a gitlab: config that resolves to several files', async () => {
    mockFetchGitLab.mockResolvedValue(twoFiles);
    await expect(loadConfig('gitlab:group/project:dir@main')).rejects.toThrow(
      'Remote config must be a single file, got 2 files',
    );
  });

  it('rejects a git remote config that resolves to several files', async () => {
    mockFetchGit.mockReturnValue(twoFiles);
    await expect(
      loadConfig('git://example.com/org/repo.git//dir'),
    ).rejects.toThrow('Remote config must be a single file, got 2 files');
  });
});
