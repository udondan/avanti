import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfigContent } from '../src/config';
import { computeSymlinkDiff } from '../src/diff';
import { atomicWrite } from '../src/writer';
import { resolveSymlinkSrcPath } from '../src/sources/local';

const isWindows = process.platform === 'win32';

const CLI = path.resolve(__dirname, '../src/cli.ts');
const PROJECT_ROOT = path.resolve(__dirname, '..');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-symlink-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runAvanti(configPath: string, workingDir: string, cmd = 'pull --yes') {
  try {
    const stdout = execSync(
      `bunx tsx "${CLI}" --config "${configPath}" --working-dir "${workingDir}" ${cmd}`,
      {
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 2,
    };
  }
}

function writeConfig(dir: string, content: string): string {
  const configPath = path.join(dir, 'avanti.yml');
  fs.writeFileSync(configPath, content);
  return configPath;
}

// ── Config parsing ─────────────────────────────────────────────────────────

describe('config parsing — symlink', () => {
  it('parses symlink: true', () => {
    const src = path.join(tmpDir, 'src.txt');
    fs.writeFileSync(src, 'x');
    const cfg = parseConfigContent(
      `files:\n  ./link:\n    src: ${src}\n    symlink: true\n`,
    );
    expect(cfg.files['./link'].symlink).toBe(true);
  });

  it('parses symlink: absolute', () => {
    const src = path.join(tmpDir, 'src.txt');
    fs.writeFileSync(src, 'x');
    const cfg = parseConfigContent(
      `files:\n  ./link:\n    src: ${src}\n    symlink: absolute\n`,
    );
    expect(cfg.files['./link'].symlink).toBe('absolute');
  });

  it('parses symlink: relative', () => {
    const src = path.join(tmpDir, 'src.txt');
    fs.writeFileSync(src, 'x');
    const cfg = parseConfigContent(
      `files:\n  ./link:\n    src: ${src}\n    symlink: relative\n`,
    );
    expect(cfg.files['./link'].symlink).toBe('relative');
  });

  it('rejects symlink: false', () => {
    const src = path.join(tmpDir, 'src.txt');
    fs.writeFileSync(src, 'x');
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: ${src}\n    symlink: false\n`,
      ),
    ).toThrow(/symlink: must be true, "absolute", or "relative"/);
  });

  it('rejects array src with symlink', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src:\n      - /tmp/a\n      - /tmp/b\n    symlink: true\n`,
      ),
    ).toThrow(/cannot be combined with a list of sources/);
  });

  it('rejects http src with symlink', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: https://example.com/file\n    symlink: true\n`,
      ),
    ).toThrow(/src must be a local path/);
  });

  it('rejects exec: src with symlink', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src:\n      exec: echo hi\n    symlink: true\n`,
      ),
    ).toThrow(/src must be a local path/);
  });

  it('rejects symlink combined with replace:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    replace:\n      - from: a\n        to: b\n`,
      ),
    ).toThrow(/cannot be combined with replace:/);
  });

  it('rejects symlink combined with template:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    template: true\n`,
      ),
    ).toThrow(/cannot be combined with template:/);
  });

  it('rejects symlink combined with json:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    json: true\n`,
      ),
    ).toThrow(/cannot be combined with json:/);
  });

  it('rejects symlink combined with writeInPlace:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    writeInPlace: true\n`,
      ),
    ).toThrow(/cannot be combined with writeInPlace:/);
  });

  it('rejects symlink combined with followSymlink:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    followSymlink: true\n`,
      ),
    ).toThrow(/cannot be combined with followSymlink:/);
  });

  it('rejects symlink combined with mode:', () => {
    expect(() =>
      parseConfigContent(
        `files:\n  ./link:\n    src: /tmp/x\n    symlink: true\n    mode: "0644"\n`,
      ),
    ).toThrow(/cannot be combined with mode:/);
  });
});

// ── resolveSymlinkSrcPath ──────────────────────────────────────────────────

describe.skipIf(isWindows)('resolveSymlinkSrcPath', () => {
  it('returns absolute path unchanged', () => {
    const abs = path.join(tmpDir, 'file.txt');
    const result = resolveSymlinkSrcPath(abs, tmpDir, {}, true, '/some/link');
    expect(result).toBe(abs);
  });

  it('resolves relative path to absolute', () => {
    const result = resolveSymlinkSrcPath(
      'file.txt',
      tmpDir,
      {},
      true,
      '/some/link',
    );
    expect(result).toBe(path.join(tmpDir, 'file.txt'));
  });

  it('expands ~ to home directory', () => {
    const result = resolveSymlinkSrcPath(
      '~/file.txt',
      tmpDir,
      {},
      true,
      '/some/link',
    );
    expect(result).toBe(path.join(os.homedir(), 'file.txt'));
  });

  it('returns relative path when mode is "relative"', () => {
    const src = path.join(tmpDir, 'src', 'file.txt');
    const linkPath = path.join(tmpDir, 'links', 'mylink');
    const result = resolveSymlinkSrcPath(src, tmpDir, {}, 'relative', linkPath);
    // Relative from links/ to src/
    expect(result).toBe('../src/file.txt');
  });

  it('resolves variables in src path', () => {
    const result = resolveSymlinkSrcPath(
      '$dir/file.txt',
      tmpDir,
      { dir: tmpDir },
      true,
      '/some/link',
    );
    expect(result).toBe(path.join(tmpDir, 'file.txt'));
  });
});

// ── computeSymlinkDiff ────────────────────────────────────────────────────

describe.skipIf(isWindows)('computeSymlinkDiff', () => {
  it('reports new symlink when path does not exist', () => {
    const link = path.join(tmpDir, 'mylink');
    const d = computeSymlinkDiff(link, '/some/target');
    expect(d.isNew).toBe(true);
    expect(d.hasChanges).toBe(true);
    expect(d.isSymlink).toBe(true);
    expect(d.patch).toContain('-> /some/target');
  });

  it('reports no changes when symlink already points to correct target', () => {
    const link = path.join(tmpDir, 'mylink');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, link);
    const d = computeSymlinkDiff(link, target);
    expect(d.hasChanges).toBe(false);
    expect(d.isSymlink).toBe(true);
  });

  it('reports change when symlink points to wrong target', () => {
    const link = path.join(tmpDir, 'mylink');
    const oldTarget = path.join(tmpDir, 'old.txt');
    const newTarget = path.join(tmpDir, 'new.txt');
    fs.writeFileSync(oldTarget, 'x');
    fs.symlinkSync(oldTarget, link);
    const d = computeSymlinkDiff(link, newTarget);
    expect(d.hasChanges).toBe(true);
    expect(d.isNew).toBe(false);
    expect(d.isSymlink).toBe(true);
    expect(d.patch).toContain(`-> ${oldTarget}`);
    expect(d.patch).toContain(`-> ${newTarget}`);
  });

  it('reports change when regular file exists at link path', () => {
    const link = path.join(tmpDir, 'mylink');
    fs.writeFileSync(link, 'regular file');
    const d = computeSymlinkDiff(link, '/some/target');
    expect(d.hasChanges).toBe(true);
    expect(d.isNew).toBe(false);
    expect(d.isSymlink).toBe(true);
  });
});

// ── atomicWrite with symlinkTarget ────────────────────────────────────────

describe.skipIf(isWindows)('atomicWrite — symlink targets', () => {
  it('creates a symlink at the target path', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const linkPath = path.join(tmpDir, 'my-link');
    fs.writeFileSync(srcFile, 'hello');
    atomicWrite([
      {
        targetPath: linkPath,
        content: Buffer.from(srcFile),
        symlinkTarget: srcFile,
      },
    ]);
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(srcFile);
  });

  it('replaces an existing file with a symlink atomically', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const linkPath = path.join(tmpDir, 'my-link');
    fs.writeFileSync(srcFile, 'hello');
    fs.writeFileSync(linkPath, 'old regular file');
    atomicWrite([
      {
        targetPath: linkPath,
        content: Buffer.from(srcFile),
        symlinkTarget: srcFile,
      },
    ]);
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(srcFile);
  });

  it('replaces an existing symlink with a new symlink', () => {
    const src1 = path.join(tmpDir, 'src1.txt');
    const src2 = path.join(tmpDir, 'src2.txt');
    const linkPath = path.join(tmpDir, 'my-link');
    fs.writeFileSync(src1, 'a');
    fs.writeFileSync(src2, 'b');
    fs.symlinkSync(src1, linkPath);
    atomicWrite([
      {
        targetPath: linkPath,
        content: Buffer.from(src2),
        symlinkTarget: src2,
      },
    ]);
    expect(fs.readlinkSync(linkPath)).toBe(src2);
  });

  it('creates parent directories if needed', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const linkPath = path.join(tmpDir, 'nested', 'dir', 'my-link');
    fs.writeFileSync(srcFile, 'hello');
    atomicWrite([
      {
        targetPath: linkPath,
        content: Buffer.from(srcFile),
        symlinkTarget: srcFile,
      },
    ]);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });
});

// ── Integration: pull creates symlink ─────────────────────────────────────

describe.skipIf(isWindows)('integration — symlink pull', () => {
  it('creates an absolute symlink on pull', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const workDir = path.join(tmpDir, 'work');
    fs.writeFileSync(srcFile, 'hello');
    fs.mkdirSync(workDir);
    const config = writeConfig(
      tmpDir,
      `files:\n  ./my-link:\n    src: ${srcFile}\n    symlink: true\n`,
    );
    const result = runAvanti(config, workDir);
    expect(result.exitCode).toBe(0);
    const linkPath = path.join(workDir, 'my-link');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(srcFile);
  });

  it('second pull is a no-op when symlink is already correct', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const workDir = path.join(tmpDir, 'work');
    fs.writeFileSync(srcFile, 'hello');
    fs.mkdirSync(workDir);
    const config = writeConfig(
      tmpDir,
      `files:\n  ./my-link:\n    src: ${srcFile}\n    symlink: true\n`,
    );
    runAvanti(config, workDir);
    const result = runAvanti(config, workDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No changes');
  });

  it('diff exits 0 when symlink matches', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const workDir = path.join(tmpDir, 'work');
    fs.writeFileSync(srcFile, 'hello');
    fs.mkdirSync(workDir);
    const config = writeConfig(
      tmpDir,
      `files:\n  ./my-link:\n    src: ${srcFile}\n    symlink: true\n`,
    );
    runAvanti(config, workDir);
    const result = runAvanti(config, workDir, 'diff');
    expect(result.exitCode).toBe(0);
  });

  it('diff exits 1 when symlink is missing', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const workDir = path.join(tmpDir, 'work');
    fs.writeFileSync(srcFile, 'hello');
    fs.mkdirSync(workDir);
    const config = writeConfig(
      tmpDir,
      `files:\n  ./my-link:\n    src: ${srcFile}\n    symlink: true\n`,
    );
    const result = runAvanti(config, workDir, 'diff');
    expect(result.exitCode).toBe(1);
  });

  it('creates a relative symlink with symlink: relative', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    const workDir = path.join(tmpDir, 'work');
    fs.writeFileSync(srcFile, 'hello');
    fs.mkdirSync(workDir);
    const config = writeConfig(
      tmpDir,
      `files:\n  ./my-link:\n    src: ${srcFile}\n    symlink: relative\n`,
    );
    const result = runAvanti(config, workDir);
    expect(result.exitCode).toBe(0);
    const linkPath = path.join(workDir, 'my-link');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const symlinkTarget = fs.readlinkSync(linkPath);
    // Should be relative, not absolute
    expect(path.isAbsolute(symlinkTarget)).toBe(false);
    // Resolved should point to the actual source file
    const resolved = path.resolve(path.dirname(linkPath), symlinkTarget);
    expect(resolved).toBe(srcFile);
  });
});
