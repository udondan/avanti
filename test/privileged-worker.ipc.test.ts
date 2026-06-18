import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/privileged-worker';

// These tests spawn dist/privileged-worker.js (not sudo) — they verify the
// full stdin/stdout IPC protocol end-to-end against paths in os.tmpdir().
// They require the project to have been built first (mise run build).
// Skipped on Windows: the build step only runs on Linux in CI.
const WORKER = path.resolve(__dirname, '../dist/privileged-worker.js');
const workerExists = fs.existsSync(WORKER);

function runWorker(request: WorkerRequest): WorkerResponse {
  const r = spawnSync('node', [WORKER], {
    input: JSON.stringify(request),
    stdio: ['pipe', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`worker exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as WorkerResponse;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `avanti-ipc-test-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!workerExists)('IPC protocol — write-mv', () => {
  it('creates a new file and returns ok:true', () => {
    const contentSrc = path.join(tmpDir, 'content.dat');
    fs.writeFileSync(contentSrc, 'hello ipc');
    const targetPath = path.join(tmpDir, 'output.txt');

    const resp = runWorker({
      ops: [
        {
          type: 'write-mv',
          targetPath,
          contentSrc,
          defaultMode: '0644',
        },
      ],
    });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].ok).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('hello ipc');
  });

  it('writes multiple files and returns one result per op', () => {
    const ops = Array.from({ length: 3 }, (_, i) => {
      const contentSrc = path.join(tmpDir, `c${i}.dat`);
      fs.writeFileSync(contentSrc, `content-${i}`);
      return {
        type: 'write-mv' as const,
        targetPath: path.join(tmpDir, `out${i}.txt`),
        contentSrc,
        defaultMode: '0644',
      };
    });

    const resp = runWorker({ ops });

    expect(resp.results).toHaveLength(3);
    for (const r of resp.results) expect(r.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(fs.readFileSync(ops[i].targetPath, 'utf8')).toBe(`content-${i}`);
    }
  });

  it('stops at the first failing op and returns ok:false with an error message', () => {
    const badTarget = path.join(tmpDir, 'subdir');
    fs.mkdirSync(badTarget); // target is a real directory — write-mv should reject it

    const contentSrc = path.join(tmpDir, 'content.dat');
    fs.writeFileSync(contentSrc, 'data');

    const afterSrc = path.join(tmpDir, 'after.dat');
    fs.writeFileSync(afterSrc, 'after');

    const resp = runWorker({
      ops: [
        {
          type: 'write-mv',
          targetPath: badTarget,
          contentSrc,
          defaultMode: '0644',
        },
        {
          type: 'write-mv',
          targetPath: path.join(tmpDir, 'after.txt'),
          contentSrc: afterSrc,
          defaultMode: '0644',
        },
      ],
    });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].ok).toBe(false);
    expect(resp.results[0].error).toBeDefined();
    // Second op was never executed.
    expect(fs.existsSync(path.join(tmpDir, 'after.txt'))).toBe(false);
  });
});

describe.skipIf(!workerExists || process.platform === 'win32')(
  'IPC protocol — write-symlink',
  () => {
    it('creates a new symlink and returns ok:true', () => {
      const targetPath = path.join(tmpDir, 'link');
      const symlinkTarget = path.join(tmpDir, 'real.txt');
      fs.writeFileSync(symlinkTarget, 'real');

      const resp = runWorker({
        ops: [{ type: 'write-symlink', targetPath, symlinkTarget }],
      });

      expect(resp.results[0].ok).toBe(true);
      expect(fs.readlinkSync(targetPath)).toBe(symlinkTarget);
    });
  },
);

describe.skipIf(!workerExists)('IPC protocol — write-in-place', () => {
  it('overwrites an existing file in-place', () => {
    const targetPath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(targetPath, 'original');
    const inoBefore = fs.statSync(targetPath).ino;

    const contentSrc = path.join(tmpDir, 'content.dat');
    fs.writeFileSync(contentSrc, 'updated');

    const resp = runWorker({
      ops: [
        {
          type: 'write-in-place',
          targetPath,
          contentSrc,
          defaultMode: '0644',
        },
      ],
    });

    expect(resp.results[0].ok).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('updated');
    if (process.platform !== 'win32') {
      expect(fs.statSync(targetPath).ino).toBe(inoBefore);
    }
  });
});

describe.skipIf(!workerExists)('IPC protocol — delete', () => {
  it('deletes an existing file', () => {
    const targetPath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(targetPath, 'gone');

    const resp = runWorker({
      ops: [{ type: 'delete', targetPath }],
    });

    expect(resp.results[0].ok).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('succeeds silently when the file does not exist', () => {
    const resp = runWorker({
      ops: [{ type: 'delete', targetPath: path.join(tmpDir, 'no-such.txt') }],
    });

    expect(resp.results[0].ok).toBe(true);
  });
});

describe.skipIf(!workerExists)('IPC protocol — malformed input', () => {
  it('returns ok:false and exits non-zero on invalid JSON', () => {
    const r = spawnSync('node', [WORKER], {
      input: 'not json at all',
      stdio: ['pipe', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    // Worker writes a JSON error response and exits 1.
    expect(r.status).toBe(1);
    const resp = JSON.parse(r.stdout) as WorkerResponse;
    expect(resp.results[0].ok).toBe(false);
    expect(resp.results[0].error).toMatch(/parse/i);
  });
});
