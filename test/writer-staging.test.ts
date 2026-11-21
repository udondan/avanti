import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type StageWorker = (workerPath: string) => string;
type Registry = typeof import('../src/writer/registry');

// WORLD_TMP is read once, when the writer modules are loaded, so each case
// points AVANTI_WORLD_TMP at a private directory and imports fresh copies.
async function loadModules(): Promise<{
  stageWorker: StageWorker;
  registry: Registry;
}> {
  vi.resetModules();
  const { _testable } = await import('../src/writer/worker-staging');
  const registry = await import('../src/writer/registry');
  return { stageWorker: _testable.stageWorkerForSudo, registry };
}

function modeOf(p: string): number {
  return fs.lstatSync(p).mode & 0o7777;
}

describe.skipIf(process.platform === 'win32')('worker staging for sudo', () => {
  let tmpDir: string;
  let worldTmp: string;
  let distDir: string;
  let workerPath: string;
  let stageWorker: StageWorker;
  let registry: Registry;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-staging-'));
    worldTmp = path.join(tmpDir, 'world');
    fs.mkdirSync(worldTmp, { mode: 0o700 });
    distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);
    workerPath = path.join(distDir, 'privileged-worker.js');
    fs.writeFileSync(workerPath, '// entry\n');
    process.env.AVANTI_WORLD_TMP = worldTmp;
    ({ stageWorker, registry } = await loadModules());
  });

  afterEach(() => {
    delete process.env.AVANTI_WORLD_TMP;
    for (const dir of fs.readdirSync(worldTmp)) {
      registry.cleanupWorkerDir(path.join(worldTmp, dir));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies the entry and every regular .js helper module', () => {
    const helperDir = path.join(distDir, 'privileged-worker');
    fs.mkdirSync(helperDir);
    fs.writeFileSync(path.join(helperDir, 'a.js'), '// a\n');
    fs.writeFileSync(path.join(helperDir, 'b.js'), '// b\n');
    fs.writeFileSync(path.join(helperDir, 'a.js.map'), '{}');
    fs.writeFileSync(path.join(helperDir, 'a.d.ts'), 'export {};');
    fs.mkdirSync(path.join(helperDir, 'nested.js'));
    fs.symlinkSync(path.join(helperDir, 'a.js'), path.join(helperDir, 'l.js'));

    const staged = stageWorker(workerPath);

    const stagedDir = path.dirname(staged);
    expect(path.dirname(stagedDir)).toBe(worldTmp);
    expect(path.basename(staged)).toBe('privileged-worker.js');
    expect(fs.readFileSync(staged, 'utf8')).toBe('// entry\n');
    expect(modeOf(stagedDir)).toBe(0o711);
    expect(modeOf(staged)).toBe(0o444);

    const stagedHelpers = path.join(stagedDir, 'privileged-worker');
    expect(modeOf(stagedHelpers)).toBe(0o711);
    expect(
      fs.readdirSync(stagedHelpers).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['a.js', 'b.js']);
    for (const name of ['a.js', 'b.js']) {
      const p = path.join(stagedHelpers, name);
      expect(fs.lstatSync(p).isFile()).toBe(true);
      expect(modeOf(p)).toBe(0o444);
    }
    expect(fs.readFileSync(path.join(stagedHelpers, 'b.js'), 'utf8')).toBe(
      '// b\n',
    );
    expect(registry.stagedWorkerDirs.has(stagedDir)).toBe(true);
  });

  it('stages only the entry when there is no helper directory', () => {
    const staged = stageWorker(workerPath);
    expect(fs.readdirSync(path.dirname(staged))).toEqual([
      'privileged-worker.js',
    ]);
  });

  it('does not follow a symlinked helper directory', () => {
    const realHelpers = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(realHelpers);
    fs.writeFileSync(path.join(realHelpers, 'a.js'), '// a\n');
    fs.symlinkSync(realHelpers, path.join(distDir, 'privileged-worker'));

    const staged = stageWorker(workerPath);
    expect(fs.readdirSync(path.dirname(staged))).toEqual([
      'privileged-worker.js',
    ]);
  });

  it('reuses the staged copy for the same worker path', () => {
    const first = stageWorker(workerPath);
    const second = stageWorker(workerPath);
    expect(second).toBe(first);
    expect(fs.readdirSync(worldTmp)).toHaveLength(1);
  });

  it('cleanup removes the staged directory including the helper modules', () => {
    const helperDir = path.join(distDir, 'privileged-worker');
    fs.mkdirSync(helperDir);
    fs.writeFileSync(path.join(helperDir, 'a.js'), '// a\n');

    const stagedDir = path.dirname(stageWorker(workerPath));
    registry.cleanupWorkerDir(stagedDir);

    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(registry.stagedWorkerDirs.has(stagedDir)).toBe(false);
  });

  it('removes the staging directory when copying fails', () => {
    const missing = path.join(distDir, 'missing.js');
    expect(() => stageWorker(missing)).toThrow(/ENOENT/);
    expect(fs.readdirSync(worldTmp)).toEqual([]);
  });
});
