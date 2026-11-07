// Edge and error paths of the delete diff, the file history and the glab token
// lookup that the regular suites do not reach.
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { computeDeleteDiff } from '../src/diff';
import { HistoryManager } from '../src/history';
import { buildVersionList } from '../src/history/pulls';
import { resolveToken } from '../src/sources/gitlab/auth';

const mockReadFile = fs.readFileSync as unknown as MockInstance;
const realReadFile = mockReadFile.getMockImplementation() as
  ((...args: unknown[]) => unknown) | undefined;
const mockSpawnSync = spawnSync as unknown as MockInstance;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-coverage-gaps-'));
});

afterEach(() => {
  if (realReadFile) mockReadFile.mockImplementation(realReadFile);
  mockSpawnSync.mockReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeDeleteDiff', () => {
  it('treats a file that vanishes before it is read as a binary delete', () => {
    const target = path.join(tmpDir, 'racy.txt');
    fs.writeFileSync(target, 'content');
    mockReadFile.mockImplementation((p: unknown, ...rest: unknown[]) => {
      if (p === target) {
        throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
      }
      return realReadFile?.(p, ...rest);
    });
    expect(computeDeleteDiff(target)).toEqual({
      targetPath: target,
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    });
  });

  it('marks an unreadable file as such', () => {
    const target = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(target, 'content');
    mockReadFile.mockImplementation((p: unknown, ...rest: unknown[]) => {
      if (p === target) {
        throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      }
      return realReadFile?.(p, ...rest);
    });
    expect(computeDeleteDiff(target)).toMatchObject({
      isDelete: true,
      isUnreadable: true,
    });
  });
});

describe('HistoryManager.getFileHistory', () => {
  let workingDir: string;

  beforeEach(() => {
    process.env.AVANTI_HISTORY_DIR = path.join(tmpDir, 'history');
    workingDir = path.join(tmpDir, 'project');
    fs.mkdirSync(workingDir);
  });

  afterEach(() => {
    delete process.env.AVANTI_HISTORY_DIR;
  });

  function pullTwoFiles(): { h: HistoryManager; a: string; b: string } {
    const h = new HistoryManager(
      path.join(workingDir, '.avanti.yml'),
      workingDir,
    );
    h.ensureStorageDir();
    const a = path.join(workingDir, 'a.txt');
    const b = path.join(workingDir, 'b.txt');
    const pullId = h.openPullSession();
    const refs = [a, b].map(
      (p) => h.stageFileVersion(pullId, p, Buffer.from(p), true).fileRef,
    );
    h.closePullSession(pullId, '.avanti.yml', refs);
    return { h, a, b };
  }

  it('attributes each version only to pulls that contain the file', () => {
    const { h, a } = pullTwoFiles();
    const [pull] = h.listPulls();
    expect(h.getFileHistory(a)).toEqual({
      absolutePath: a,
      existedBeforeAvanti: false,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          isOriginal: false,
          pulledAt: pull.timestamp,
          pullId: pull.pullId,
        },
      ],
    });
  });

  it('returns null when the pull log holds an entry without a file list', () => {
    const { b } = pullTwoFiles();
    const projectsDir = path.join(tmpDir, 'history', 'projects');
    const [project] = fs.readdirSync(projectsDir);
    fs.appendFileSync(
      path.join(projectsDir, project, 'pulls.jsonl'),
      JSON.stringify({ pullId: 'broken', timestamp: 'now' }) + '\n',
    );
    // A fresh manager reads the log without the cache of the first one.
    const h = new HistoryManager(
      path.join(workingDir, '.avanti.yml'),
      workingDir,
    );
    expect(h.getFileMeta(b)).not.toBeNull();
    expect(h.getFileHistory(b)).toBeNull();
  });
});

describe('buildVersionList', () => {
  it('ignores refs of other files in the same pull', () => {
    const versions = buildVersionList(
      '/w/a',
      {
        absolutePath: '/w/a',
        slug: 's',
        firstSeenAt: 't0',
        existedBeforeAvanti: true,
        currentVersion: 2,
      },
      [
        {
          pullId: 'p1',
          timestamp: 't1',
          configFile: 'c',
          files: [
            { absolutePath: '/w/b', slug: 'x', version: 1, wasNew: true },
            { absolutePath: '/w/a', slug: 's', version: 1, wasNew: false },
          ],
        },
        {
          pullId: 'p2',
          timestamp: 't2',
          configFile: 'c',
          files: [
            { absolutePath: '/w/b', slug: 'x', version: 2, wasNew: false },
          ],
        },
      ],
    );
    expect(versions).toEqual([
      { version: 0, isOriginal: true, pulledAt: null, pullId: null },
      { version: 1, isOriginal: false, pulledAt: 't1', pullId: 'p1' },
      // Version 2 of /w/a has no pull: /w/b's version 2 must not be used.
      { version: 2, isOriginal: false, pulledAt: null, pullId: null },
    ]);
  });
});

describe('gitlab resolveToken', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_HOST;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('finds no token when glab produced no output streams', () => {
    // spawnSync leaves stdout/stderr null when glab could not be started.
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: null,
      stderr: null,
      error: Object.assign(new Error('spawnSync glab ENOENT'), {
        code: 'ENOENT',
      }),
    });
    expect(resolveToken('git.example.com')).toBeUndefined();
    // Both the scoped and the --all lookup were attempted.
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('reads the token from stderr of the scoped lookup', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'git.example.com\n',
      stderr: '  ✓ Token found: glpat-scoped\n',
    });
    expect(resolveToken('git.example.com')).toBe('glpat-scoped');
  });

  it('picks the token of the configured host from the --all output', () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: null, stderr: 'not logged in' })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          'gitlab.com\n  ✓ Token found: glpat-other\nssh.git.example.com\n',
        stderr: '  ✓ Token found: glpat-mine\n',
      });
    expect(resolveToken('git.example.com')).toBe('glpat-mine');
  });
});
