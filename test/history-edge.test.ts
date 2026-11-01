import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

import * as fs from 'fs';
import { HistoryManager } from '../src/history';

const mockReadFile = fs.readFileSync as unknown as MockInstance;
const mockReaddir = fs.readdirSync as unknown as MockInstance;

let tmpDir: string;
let historyDir: string;
let realReadFile: (...args: unknown[]) => unknown;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-history-edge-'));
  historyDir = path.join(tmpDir, 'history');
  process.env.AVANTI_HISTORY_DIR = historyDir;
  realReadFile = mockReadFile.getMockImplementation() as typeof realReadFile;
});

afterEach(() => {
  mockReadFile.mockImplementation(realReadFile);
  mockReaddir.mockClear();
  delete process.env.AVANTI_HISTORY_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager(workingDir = path.join(tmpDir, 'project')) {
  return new HistoryManager(path.join(workingDir, '.avanti.yml'), workingDir);
}

/** Make readFileSync throw `code` for `target`; other paths read normally. */
function failReadFor(target: string, code: string): void {
  mockReadFile.mockImplementation((...args: unknown[]) => {
    if (args[0] === target) {
      const e = new Error(code) as NodeJS.ErrnoException;
      e.code = code;
      throw e;
    }
    return realReadFile(...args);
  });
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function fileDirFor(h: HistoryManager, target: string): string {
  const meta = h.getFileMeta(target)!;
  return path.join(
    historyDir,
    'projects',
    fs.readdirSync(path.join(historyDir, 'projects'))[0],
    'files',
    meta.slug,
  );
}

describe('stageFileVersion — original capture', () => {
  it('persists an isSymlink change for an already-tracked file', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'out');
    const id1 = h.openPullSession();
    const r1 = h.stageFileVersion(id1, target, buf('a'), true);
    h.closePullSession(id1, 'cfg', [r1.fileRef]);

    const id2 = h.openPullSession();
    const r2 = h.stageFileVersion(
      id2,
      target,
      buf('link-target'),
      false,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(r2.fileRef.isSymlink).toBe(true);
    expect(h.getFileMeta(target)?.isSymlink).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'captures the previous symlink target for a symlink entry',
    () => {
      const h = makeManager();
      h.ensureStorageDir();
      const target = path.join(tmpDir, 'link');
      fs.symlinkSync('old-target', target);
      const id = h.openPullSession();
      h.stageFileVersion(
        id,
        target,
        buf('new-target'),
        false,
        undefined,
        undefined,
        undefined,
        true,
      );
      const meta = h.getFileMeta(target)!;
      expect(meta.v0IsSymlink).toBe(true);
      expect(meta.isSymlink).toBe(true);
      expect(h.readVersion(target, 0)?.toString()).toBe('old-target');
    },
  );

  it('captures a regular file being replaced by a symlink entry', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'file');
    fs.writeFileSync(target, 'original');
    const id = h.openPullSession();
    h.stageFileVersion(
      id,
      target,
      buf('t'),
      false,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(true);
    expect(h.readVersion(target, 0)?.toString()).toBe('original');
  });

  it('does not claim a directory predated avanti for a symlink entry', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'adir');
    fs.mkdirSync(target);
    const id = h.openPullSession();
    h.stageFileVersion(
      id,
      target,
      buf('t'),
      false,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(false);
    expect(h.readVersion(target, 0)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'captures an existing symlink replaced by a regular file entry',
    () => {
      const h = makeManager();
      h.ensureStorageDir();
      const target = path.join(tmpDir, 'link');
      fs.symlinkSync('pointee', target);
      const id = h.openPullSession();
      h.stageFileVersion(id, target, buf('content'), false);
      const meta = h.getFileMeta(target)!;
      expect(meta.v0IsSymlink).toBe(true);
      expect(meta.isSymlink).toBeUndefined();
      expect(h.readVersion(target, 0)?.toString()).toBe('pointee');
    },
  );

  it('keeps existedBeforeAvanti for an unreadable original without override', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'secret');
    fs.writeFileSync(target, 'x');
    failReadFor(target, 'EACCES');
    const id = h.openPullSession();
    h.stageFileVersion(id, target, buf('new'), false);
    mockReadFile.mockImplementation(realReadFile);
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(true);
    expect(h.readVersion(target, 0)).toBeNull();
  });

  it('uses v0Override (and its symlink flag) when the original is unreadable', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'secret');
    fs.writeFileSync(target, 'x');
    failReadFor(target, 'EPERM');
    const id = h.openPullSession();
    h.stageFileVersion(
      id,
      target,
      buf('new'),
      false,
      undefined,
      'root',
      buf('sudo-read-original'),
      false,
      true,
    );
    mockReadFile.mockImplementation(realReadFile);
    const meta = h.getFileMeta(target)!;
    expect(meta.v0IsSymlink).toBe(true);
    expect(h.readVersion(target, 0)?.toString()).toBe('sudo-read-original');
  });

  it('uses v0Override without the symlink flag', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'secret');
    fs.writeFileSync(target, 'x');
    failReadFor(target, 'EACCES');
    const id = h.openPullSession();
    h.stageFileVersion(
      id,
      target,
      buf('new'),
      false,
      undefined,
      true,
      buf('orig'),
    );
    mockReadFile.mockImplementation(realReadFile);
    expect(h.getFileMeta(target)?.v0IsSymlink).toBeUndefined();
    expect(h.readVersion(target, 0)?.toString()).toBe('orig');
  });

  it('treats ENOENT on the original as "did not exist before avanti"', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'vanishing');
    fs.writeFileSync(target, 'x');
    failReadFor(target, 'ENOENT');
    const id = h.openPullSession();
    h.stageFileVersion(id, target, buf('new'), false);
    mockReadFile.mockImplementation(realReadFile);
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(false);
  });

  it('rethrows unexpected errors while capturing the original', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'broken');
    fs.writeFileSync(target, 'x');
    failReadFor(target, 'EIO');
    const id = h.openPullSession();
    expect(() => h.stageFileVersion(id, target, buf('new'), false)).toThrow(
      'EIO',
    );
  });
});

describe('ensureStorageDir failure', () => {
  it('warns and returns false when storage cannot be created', () => {
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, '');
    process.env.AVANTI_HISTORY_DIR = blocker;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(makeManager().ensureStorageDir()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not initialise history storage'),
    );
    warn.mockRestore();
  });
});

describe('corrupt storage is tolerated', () => {
  function projectDir(h: HistoryManager): string {
    h.ensureStorageDir();
    const projects = path.join(historyDir, 'projects');
    return path.join(projects, fs.readdirSync(projects)[0]);
  }

  it('listPulls returns [] when pulls.jsonl cannot be read', () => {
    const h = makeManager();
    fs.mkdirSync(path.join(projectDir(h), 'pulls.jsonl'));
    expect(h.listPulls()).toEqual([]);
  });

  it('index lookups return null/[] when index.json is not an object', () => {
    const h = makeManager();
    const dir = projectDir(h);
    fs.writeFileSync(path.join(dir, 'files', 'index.json'), 'null');
    expect(h.getFileHistory('/x')).toBeNull();
    expect(h.getFileMeta('/x')).toBeNull();
    expect(h.readVersion('/x', 1)).toBeNull();
    expect(h.listTrackedFiles()).toEqual([]);
    // saveInsertedFragment swallows the error
    expect(() => h.saveInsertedFragment('/x', 'r', 'p')).not.toThrow();
  });

  it('index.json that is not valid JSON is treated as empty', () => {
    const h = makeManager();
    const dir = projectDir(h);
    fs.writeFileSync(path.join(dir, 'files', 'index.json'), '{not json');
    expect(h.getFileMeta('/x')).toBeNull();
  });

  it('readMeta returns null for corrupt meta.json', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'f');
    const id = h.openPullSession();
    const r = h.stageFileVersion(id, target, buf('a'), true);
    h.closePullSession(id, 'cfg', [r.fileRef]);
    const metaPath = path.join(fileDirFor(h, target), 'meta.json');
    fs.writeFileSync(metaPath, '{corrupt');
    expect(h.getFileMeta(target)).toBeNull();
    expect(h.getFileHistory(target)).toBeNull();
    expect(h.listTrackedFiles()).toEqual([]);
  });
});

describe('HistoryManager.findByWorkingDir', () => {
  it('returns [] when no projects directory exists', () => {
    expect(HistoryManager.findByWorkingDir('/nowhere')).toEqual([]);
  });

  it('returns [] when the projects directory cannot be listed', () => {
    makeManager().ensureStorageDir();
    mockReaddir.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(HistoryManager.findByWorkingDir('/nowhere')).toEqual([]);
  });

  it('finds matching projects and skips corrupt or missing meta', () => {
    const wd = path.join(tmpDir, 'project');
    const h = makeManager(wd);
    h.ensureStorageDir();
    makeManager(path.join(tmpDir, 'other')).ensureStorageDir();
    const projects = path.join(historyDir, 'projects');
    fs.mkdirSync(path.join(projects, 'no-meta'));
    fs.mkdirSync(path.join(projects, 'corrupt'));
    fs.writeFileSync(path.join(projects, 'corrupt', 'meta.json'), '{bad');

    const found = HistoryManager.findByWorkingDir(
      `${wd}${path.sep}sub${path.sep}..`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].hasHistory()).toBe(false);
  });
});

describe('inserted fragments', () => {
  it('returns null when the file is not tracked', () => {
    expect(makeManager().getInsertedFragment('/nope')).toBeNull();
  });

  it('creates a minimal entry for an untracked existing file', () => {
    const h = makeManager();
    const target = path.join(tmpDir, 'existing');
    fs.writeFileSync(target, 'before');
    h.saveInsertedFragment(target, 'raw', 'processed');
    expect(h.getInsertedFragment(target)).toEqual({
      raw: 'raw',
      processed: 'processed',
    });
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(true);
    expect(h.readVersion(target, 0)?.toString()).toBe('before');
  });

  it('creates a minimal entry for an untracked new file', () => {
    const h = makeManager();
    const target = path.join(tmpDir, 'new');
    h.saveInsertedFragment(target, 'r', 'p');
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(false);
    expect(h.readVersion(target, 0)).toBeNull();
  });

  it('updates the fragment on an already-tracked file', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'tracked');
    const id = h.openPullSession();
    const r = h.stageFileVersion(id, target, buf('a'), true);
    h.closePullSession(id, 'cfg', [r.fileRef]);
    h.saveInsertedFragment(target, 'r1', 'p1');
    h.saveInsertedFragment(target, 'r2', 'p2');
    expect(h.getInsertedFragment(target)).toEqual({
      raw: 'r2',
      processed: 'p2',
    });
    expect(h.getFileMeta(target)?.currentVersion).toBe(1);
  });

  it('stores what the insert added, and drops it when an update has none', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'owned');
    h.saveInsertedFragment(target, 'r1', 'p1', { format: 'ini' });
    expect(h.getInsertedFragment(target)).toEqual({
      raw: 'r1',
      processed: 'p1',
      owned: { format: 'ini' },
    });
    h.saveInsertedFragment(target, 'r2', 'p2');
    expect(h.getInsertedFragment(target)).toEqual({
      raw: 'r2',
      processed: 'p2',
    });
  });

  it('recreates meta when the index points at a missing meta.json', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'orphan');
    fs.writeFileSync(target, 'orig');
    const id = h.openPullSession();
    const r = h.stageFileVersion(id, target, buf('a'), true);
    h.closePullSession(id, 'cfg', [r.fileRef]);
    const dir = fileDirFor(h, target);
    fs.rmSync(dir, { recursive: true, force: true });

    h.saveInsertedFragment(target, 'r', 'p');
    const meta = h.getFileMeta(target)!;
    expect(meta.insertedFragment).toEqual({ raw: 'r', processed: 'p' });
    expect(meta.existedBeforeAvanti).toBe(true);
    expect(meta.currentVersion).toBe(0);
    expect(h.readVersion(target, 0)?.toString()).toBe('orig');
  });

  it('recreates meta without v0 when the target does not exist', () => {
    const h = makeManager();
    h.ensureStorageDir();
    const target = path.join(tmpDir, 'gone');
    const id = h.openPullSession();
    const r = h.stageFileVersion(id, target, buf('a'), true);
    h.closePullSession(id, 'cfg', [r.fileRef]);
    fs.rmSync(fileDirFor(h, target), { recursive: true, force: true });

    h.saveInsertedFragment(target, 'r', 'p');
    expect(h.getFileMeta(target)?.existedBeforeAvanti).toBe(false);
  });
});
