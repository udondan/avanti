import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryManager } from '../src/history';

let tmpDir: string;
let historyDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-history-test-'));
  historyDir = path.join(tmpDir, 'history');
  process.env.AVANTI_HISTORY_DIR = historyDir;
});

afterEach(() => {
  delete process.env.AVANTI_HISTORY_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager(
  configFile = '/project/.avanti.yml',
  workingDir = '/project',
) {
  return new HistoryManager(configFile, workingDir);
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('HistoryManager.ensureStorageDir', () => {
  it('creates storage dirs and returns true', () => {
    const h = makeManager();
    expect(h.ensureStorageDir()).toBe(true);
    expect(fs.existsSync(historyDir)).toBe(true);
  });

  it('returns true when dirs already exist', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.ensureStorageDir()).toBe(true);
  });
});

describe('HistoryManager project scoping', () => {
  it('uses different buckets for different working directories', () => {
    const h1 = makeManager('/cfg.yml', '/project-a');
    const h2 = makeManager('/cfg.yml', '/project-b');
    h1.ensureStorageDir();
    h2.ensureStorageDir();
    // Both should create their own project directories
    const projects = fs.readdirSync(path.join(historyDir, 'projects'));
    expect(projects.length).toBe(2);
  });

  it('uses different buckets for different config files', () => {
    const h1 = makeManager('/project/.avanti.yml', '/project');
    const h2 = makeManager('/project/.avanti-b.yml', '/project');
    h1.ensureStorageDir();
    h2.ensureStorageDir();
    const projects = fs.readdirSync(path.join(historyDir, 'projects'));
    expect(projects.length).toBe(2);
  });

  it('uses same bucket for same config+workingDir', () => {
    const h1 = makeManager('/project/.avanti.yml', '/project');
    const h2 = makeManager('/project/.avanti.yml', '/project');
    h1.ensureStorageDir();
    h2.ensureStorageDir();
    const projects = fs.readdirSync(path.join(historyDir, 'projects'));
    expect(projects.length).toBe(1);
  });
});

describe('HistoryManager.stageFileVersion and closePullSession', () => {
  it('captures v0 (original) for an existing file on first stage', () => {
    const targetFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const { version, fileRef } = h.stageFileVersion(
      pullId,
      targetFile,
      buf('new content'),
      false,
    );
    expect(version).toBe(1);
    expect(fileRef.version).toBe(1);
    expect(fileRef.wasNew).toBe(false);
    expect(fileRef.absolutePath).toBe(targetFile);

    h.closePullSession(pullId, '/project/.avanti.yml', [fileRef]);

    const meta = h.getFileMeta(targetFile);
    expect(meta).not.toBeNull();
    expect(meta!.existedBeforeAvanti).toBe(true);
    expect(meta!.currentVersion).toBe(1);

    expect(h.readVersion(targetFile, 0)?.toString('utf8')).toBe(
      'original content',
    );
    expect(h.readVersion(targetFile, 1)?.toString('utf8')).toBe('new content');
  });

  it('marks file as not existing before avanti when isNew=true', () => {
    const targetFile = path.join(tmpDir, 'brand-new.txt');
    // File does not exist on disk

    const h = makeManager();
    h.ensureStorageDir();
    const pullId = h.openPullSession();

    const { fileRef } = h.stageFileVersion(
      pullId,
      targetFile,
      buf('created by avanti'),
      true,
    );
    h.closePullSession(pullId, '/project/.avanti.yml', [fileRef]);

    const meta = h.getFileMeta(targetFile);
    expect(meta!.existedBeforeAvanti).toBe(false);
    expect(h.readVersion(targetFile, 0)).toBeNull();
    expect(h.readVersion(targetFile, 1)?.toString('utf8')).toBe(
      'created by avanti',
    );
  });

  it('increments version number on subsequent pulls', () => {
    const targetFile = path.join(tmpDir, 'versioned.txt');
    fs.writeFileSync(targetFile, 'v0', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();

    const pull1 = h.openPullSession();
    const { fileRef: ref1 } = h.stageFileVersion(
      pull1,
      targetFile,
      buf('v1'),
      false,
    );
    h.closePullSession(pull1, '/project/.avanti.yml', [ref1]);
    expect(ref1.version).toBe(1);

    const pull2 = h.openPullSession();
    const { fileRef: ref2 } = h.stageFileVersion(
      pull2,
      targetFile,
      buf('v2'),
      false,
    );
    h.closePullSession(pull2, '/project/.avanti.yml', [ref2]);
    expect(ref2.version).toBe(2);

    expect(h.readVersion(targetFile, 1)?.toString('utf8')).toBe('v1');
    expect(h.readVersion(targetFile, 2)?.toString('utf8')).toBe('v2');
  });

  it('does not record entry in pulls.jsonl when closePullSession is not called', () => {
    const targetFile = path.join(tmpDir, 'noop.txt');
    fs.writeFileSync(targetFile, 'original', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();
    const pullId = h.openPullSession();
    h.stageFileVersion(pullId, targetFile, buf('new'), false);
    // Deliberately not calling closePullSession (simulates no-op or failed write)

    expect(h.listPulls()).toHaveLength(0);
  });
});

describe('HistoryManager.listPulls', () => {
  it('returns empty array when no history exists', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.listPulls()).toEqual([]);
  });

  it('returns pulls newest first', () => {
    const targetFile = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(targetFile, 'orig', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();

    const p1 = h.openPullSession();
    const { fileRef: r1 } = h.stageFileVersion(
      p1,
      targetFile,
      buf('v1'),
      false,
    );
    h.closePullSession(p1, '/project/.avanti.yml', [r1]);

    const p2 = h.openPullSession();
    const { fileRef: r2 } = h.stageFileVersion(
      p2,
      targetFile,
      buf('v2'),
      false,
    );
    h.closePullSession(p2, '/project/.avanti.yml', [r2]);

    const pulls = h.listPulls();
    expect(pulls).toHaveLength(2);
    expect(pulls[0].pullId).toBe(p2); // newest first
    expect(pulls[1].pullId).toBe(p1);
  });

  it('returns empty array gracefully when history dir is deleted', () => {
    const h = makeManager();
    h.ensureStorageDir();
    fs.rmSync(historyDir, { recursive: true, force: true });
    expect(h.listPulls()).toEqual([]);
  });
});

describe('HistoryManager.getFileHistory', () => {
  it('returns null for untracked file', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.getFileHistory('/nonexistent/file.txt')).toBeNull();
  });

  it('returns correct version list including v0', () => {
    const targetFile = path.join(tmpDir, 'tracked.txt');
    fs.writeFileSync(targetFile, 'original', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();
    const pullId = h.openPullSession();
    const { fileRef } = h.stageFileVersion(
      pullId,
      targetFile,
      buf('new'),
      false,
    );
    h.closePullSession(pullId, '/project/.avanti.yml', [fileRef]);

    const fh = h.getFileHistory(targetFile);
    expect(fh).not.toBeNull();
    expect(fh!.existedBeforeAvanti).toBe(true);
    expect(fh!.currentVersion).toBe(1);
    expect(fh!.versions).toHaveLength(2); // v0 + v1
    expect(fh!.versions[0].version).toBe(0);
    expect(fh!.versions[0].isOriginal).toBe(true);
    expect(fh!.versions[1].version).toBe(1);
    expect(fh!.versions[1].pullId).toBe(pullId);
  });
});

describe('HistoryManager.getFilesAtPull', () => {
  it('returns empty map for unknown pullId', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.getFilesAtPull('nonexistent').size).toBe(0);
  });

  it('returns correct snapshot at given pull', () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(f1, 'orig-a', 'utf8');
    fs.writeFileSync(f2, 'orig-b', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();

    const p1 = h.openPullSession();
    const { fileRef: r1a } = h.stageFileVersion(p1, f1, buf('a-v1'), false);
    h.closePullSession(p1, '/project/.avanti.yml', [r1a]);

    const p2 = h.openPullSession();
    const { fileRef: r2a } = h.stageFileVersion(p2, f1, buf('a-v2'), false);
    const { fileRef: r2b } = h.stageFileVersion(p2, f2, buf('b-v1'), false);
    h.closePullSession(p2, '/project/.avanti.yml', [r2a, r2b]);

    // State after p1: only f1 at v1
    const snap1 = h.getFilesAtPull(p1);
    expect(snap1.size).toBe(1);
    expect(snap1.get(f1)?.version).toBe(1);

    // State after p2: f1 at v2, f2 at v1
    const snap2 = h.getFilesAtPull(p2);
    expect(snap2.size).toBe(2);
    expect(snap2.get(f1)?.version).toBe(2);
    expect(snap2.get(f2)?.version).toBe(1);
  });

  it('returns correct version for file updated in pull 1 and pull 3 when queried at pull 2', () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(f1, 'orig-a', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();

    // Pull 1: update f1 to 'a-v1'
    const p1 = h.openPullSession();
    const { fileRef: r1a } = h.stageFileVersion(p1, f1, buf('a-v1'), false);
    h.closePullSession(p1, '/project/.avanti.yml', [r1a]);

    // Pull 2: update f1 to 'a-v2', add new file f2 to 'b-v1'
    const p2 = h.openPullSession();
    const { fileRef: r2a } = h.stageFileVersion(p2, f1, buf('a-v2'), false);
    const { fileRef: r2b } = h.stageFileVersion(p2, f2, buf('b-v1'), true);
    h.closePullSession(p2, '/project/.avanti.yml', [r2a, r2b]);

    // Pull 3: update f1 to 'a-v3'
    const p3 = h.openPullSession();
    const { fileRef: r3a } = h.stageFileVersion(p3, f1, buf('a-v3'), false);
    h.closePullSession(p3, '/project/.avanti.yml', [r3a]);

    // Query at pull 2: f1 at v2, f2 at v1
    const snapP2 = h.getFilesAtPull(p2);
    expect(snapP2.get(f1)?.version).toBe(2);
    expect(snapP2.get(f2)?.version).toBe(1);

    // Query at pull 1: f1 at v1, f2 should not exist
    const snapP1 = h.getFilesAtPull(p1);
    expect(snapP1.get(f1)?.version).toBe(1);
    expect(snapP1.has(f2)).toBe(false);

    // Query at pull 3: f1 at v3, f2 at v1
    const snapP3 = h.getFilesAtPull(p3);
    expect(snapP3.get(f1)?.version).toBe(3);
    expect(snapP3.get(f2)?.version).toBe(1);
  });
});

describe('HistoryManager.getLastPullFiles', () => {
  it('returns empty array when no pulls recorded', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.getLastPullFiles()).toEqual([]);
  });

  it('returns files from the most recent pull', () => {
    const f = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(f, 'orig', 'utf8');

    const h = makeManager();
    h.ensureStorageDir();

    const p1 = h.openPullSession();
    const { fileRef: r1 } = h.stageFileVersion(p1, f, buf('v1'), false);
    h.closePullSession(p1, '/project/.avanti.yml', [r1]);

    const p2 = h.openPullSession();
    const { fileRef: r2 } = h.stageFileVersion(p2, f, buf('v2'), false);
    h.closePullSession(p2, '/project/.avanti.yml', [r2]);

    const last = h.getLastPullFiles();
    expect(last).toHaveLength(1);
    expect(last[0].version).toBe(2);
  });
});

describe('HistoryManager graceful degradation', () => {
  it('readVersion returns null for missing version file', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.readVersion('/never/tracked.txt', 1)).toBeNull();
  });

  it('getFileMeta returns null for untracked file', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.getFileMeta('/never/tracked.txt')).toBeNull();
  });

  it('listTrackedFiles returns empty array when history dir missing', () => {
    const h = makeManager();
    // Never called ensureStorageDir — dir doesn't exist
    expect(h.listTrackedFiles()).toEqual([]);
  });

  it('hasHistory returns false when pulls.jsonl does not exist', () => {
    const h = makeManager();
    h.ensureStorageDir();
    expect(h.hasHistory()).toBe(false);
  });

  it('hasHistory returns true after a pull is recorded', () => {
    const f = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(f, 'x', 'utf8');
    const h = makeManager();
    h.ensureStorageDir();
    const p = h.openPullSession();
    const { fileRef } = h.stageFileVersion(p, f, buf('y'), false);
    h.closePullSession(p, '/project/.avanti.yml', [fileRef]);
    expect(h.hasHistory()).toBe(true);
  });
});
