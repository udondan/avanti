import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/privileged-worker';

// These tests spawn dist/privileged-worker.js (not sudo) — they verify the
// full stdin/stdout IPC protocol end-to-end against paths in os.tmpdir().
// They require the project to have been built first (mise run build).
// Skipped on Windows: the build step only runs on Linux in CI.
const WORKER = path.resolve(__dirname, '../dist/privileged-worker.js');
const workerExists = fs.existsSync(WORKER);
const isWindows = process.platform === 'win32';

if (!isWindows && !workerExists) {
  console.warn(
    `[ipc test] dist/privileged-worker.js not found — tests skipped. Run 'mise run build' first.`,
  );
}

function b64(content: string): string {
  return Buffer.from(content).toString('base64');
}

function runWorker(request: WorkerRequest): WorkerResponse {
  // The worker computes trustedUids itself from SUDO_UID and process.getuid().
  // In test context (no sudo), SUDO_UID is unset so trustedUids = {0, current_uid},
  // which covers /tmp (root-owned) and the test tmpDir (current-user-owned).
  // stdin mode now requires a nonce: prepend it as the first line so the worker
  // can verify the caller before accepting any ops.
  const nonce = crypto.randomBytes(32).toString('hex');
  const r = spawnSync('node', [WORKER], {
    input: nonce + '\n' + JSON.stringify(request),
    env: { ...process.env, AVANTI_WORKER_NONCE: nonce },
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

describe.skipIf(isWindows || !workerExists)('IPC protocol — write-mv', () => {
  it('creates a new file and returns ok:true', () => {
    const targetPath = path.join(tmpDir, 'output.txt');

    const resp = runWorker({
      ops: [
        {
          type: 'write-mv',
          targetPath,
          contentB64: b64('hello ipc'),
          defaultMode: '0644',
        },
      ],
    });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].ok).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('hello ipc');
  });

  it('writes multiple files and returns one result per op', () => {
    const ops = Array.from({ length: 3 }, (_, i) => ({
      type: 'write-mv' as const,
      targetPath: path.join(tmpDir, `out${i}.txt`),
      contentB64: b64(`content-${i}`),
      defaultMode: '0644',
    }));

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

    const resp = runWorker({
      ops: [
        {
          type: 'write-mv',
          targetPath: badTarget,
          contentB64: b64('data'),
          defaultMode: '0644',
        },
        {
          type: 'write-mv',
          targetPath: path.join(tmpDir, 'after.txt'),
          contentB64: b64('after'),
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

  it('continues past a failing op when continueOnError is true', () => {
    const badTarget = path.join(tmpDir, 'subdir');
    fs.mkdirSync(badTarget); // directory — write-mv will reject it

    const goodTarget = path.join(tmpDir, 'after.txt');

    const resp = runWorker({
      continueOnError: true,
      ops: [
        {
          type: 'write-mv',
          targetPath: badTarget,
          contentB64: b64('data'),
          defaultMode: '0644',
        },
        {
          type: 'write-mv',
          targetPath: goodTarget,
          contentB64: b64('after'),
          defaultMode: '0644',
        },
      ],
    });

    expect(resp.results).toHaveLength(2);
    expect(resp.results[0].ok).toBe(false);
    expect(resp.results[0].error).toBeDefined();
    expect(resp.results[1].ok).toBe(true);
    // Second op was executed despite the first failing.
    expect(fs.readFileSync(goodTarget, 'utf8')).toBe('after');
  });
});

describe.skipIf(isWindows || !workerExists)(
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

describe.skipIf(isWindows || !workerExists)(
  'IPC protocol — write-in-place',
  () => {
    it('overwrites an existing file in-place', () => {
      const targetPath = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(targetPath, 'original');
      const inoBefore = fs.statSync(targetPath).ino;

      const resp = runWorker({
        ops: [
          {
            type: 'write-in-place',
            targetPath,
            contentB64: b64('updated'),
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
  },
);

describe.skipIf(isWindows || !workerExists)('IPC protocol — delete', () => {
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

  it('returns ok:false when deletion fails (target is a directory)', () => {
    const targetPath = path.join(tmpDir, 'a-dir');
    fs.mkdirSync(targetPath);

    const resp = runWorker({
      ops: [{ type: 'delete', targetPath }],
    });

    expect(resp.results[0].ok).toBe(false);
    expect(resp.results[0].error).toBeDefined();
  });
});

describe.skipIf(isWindows || !workerExists)(
  'IPC protocol — malformed input',
  () => {
    it('returns ok:false and exits non-zero on invalid JSON', () => {
      const nonce = crypto.randomBytes(32).toString('hex');
      const r = spawnSync('node', [WORKER], {
        // Prepend the nonce line so the worker proceeds past nonce verification,
        // then receives invalid JSON for the op — triggering the parse error.
        input: nonce + '\nnot json at all',
        env: { ...process.env, AVANTI_WORKER_NONCE: nonce },
        stdio: ['pipe', 'pipe', 'inherit'],
        encoding: 'utf8',
      });
      // Worker writes a JSON error response and exits 1.
      expect(r.status).toBe(1);
      const resp = JSON.parse(r.stdout) as WorkerResponse;
      expect(resp.results[0].ok).toBe(false);
      expect(resp.results[0].error).toMatch(/parse/i);
    });
  },
);

// ---------------------------------------------------------------------------
// Socket IPC mode — exercises the --socket-path / nonce / persistent-session
// path used by SudoWorkerSession (the production path for all avanti pulls).
// ---------------------------------------------------------------------------

/**
 * Spawn the worker in socket mode, complete the nonce handshake, send one or
 * more JSON requests, and return all responses.  The server is closed and the
 * worker process is killed in the afterEach cleanup tracked by the caller.
 */
function runWorkerOverSocket(
  socketPath: string,
  nonce: string,
  requests: WorkerRequest[],
  // workerNonce lets callers inject a *different* nonce into the worker to
  // test the mismatch rejection path. Defaults to nonce (the happy path).
  workerNonce?: string,
): Promise<WorkerResponse[]> {
  return new Promise((resolve, reject) => {
    const responses: WorkerResponse[] = [];
    let nonceVerified = false;
    let pendingIdx = 0;

    const server = net.createServer({ allowHalfOpen: true });
    server.listen(socketPath, () => {
      const proc = spawn('node', [WORKER, `--socket-path=${socketPath}`], {
        env: { ...process.env, AVANTI_WORKER_NONCE: workerNonce ?? nonce },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0 && pendingIdx < requests.length) {
          reject(new Error(`worker exited ${code} before all responses`));
        }
      });
    });
    server.on('error', reject);

    server.on('connection', (socket) => {
      server.close(); // accept only one connection
      const rl = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (!nonceVerified) {
          nonceVerified = true;
          if (trimmed !== nonce) {
            socket.destroy();
            reject(new Error(`nonce mismatch: got ${trimmed}`));
            return;
          }
          // Nonce OK — send the first request.
          socket.write(JSON.stringify(requests[pendingIdx++]) + '\n');
          return;
        }
        const resp = JSON.parse(trimmed) as WorkerResponse;
        responses.push(resp);
        if (pendingIdx < requests.length) {
          socket.write(JSON.stringify(requests[pendingIdx++]) + '\n');
        } else {
          socket.destroy();
          resolve(responses);
        }
      });

      rl.on('close', () => {
        if (
          responses.length < requests.length &&
          pendingIdx >= requests.length
        ) {
          resolve(responses); // all sent, some may have been received
        }
      });

      socket.on('error', (err) => {
        if (
          !err.message.includes('ECONNRESET') &&
          !err.message.includes('ERR_STREAM_DESTROYED')
        ) {
          reject(err);
        }
      });
    });
  });
}

describe.skipIf(isWindows || !workerExists)(
  'socket IPC mode — nonce handshake and persistent session',
  () => {
    let socketPath: string;
    let socketNonce: string;

    beforeEach(() => {
      socketPath = path.join(
        tmpDir,
        `test-${crypto.randomBytes(4).toString('hex')}.sock`,
      );
      socketNonce = crypto.randomBytes(32).toString('hex');
    });

    it('completes nonce handshake and processes a write-mv request', async () => {
      const targetPath = path.join(tmpDir, 'socket-out.txt');
      const [resp] = await runWorkerOverSocket(socketPath, socketNonce, [
        {
          ops: [
            {
              type: 'write-mv',
              targetPath,
              contentB64: b64('socket hello'),
              defaultMode: '0644',
            },
          ],
        },
      ]);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].ok).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('socket hello');
    });

    it('rejects a connection that sends the wrong nonce', async () => {
      // The helper expects `socketNonce` but the worker is given a different
      // nonce — simulating a rogue process connecting with a forged nonce.
      const wrongNonce = 'deadbeef'.repeat(8);
      await expect(
        runWorkerOverSocket(
          socketPath,
          socketNonce, // helper expects this
          [
            {
              ops: [
                {
                  type: 'write-mv',
                  targetPath: path.join(tmpDir, 'x.txt'),
                  contentB64: b64('x'),
                  defaultMode: '0644',
                },
              ],
            },
          ],
          wrongNonce, // worker sends this — mismatch
        ),
      ).rejects.toThrow(/nonce mismatch/);
    });

    it('processes multiple sequential requests on one socket connection', async () => {
      const paths = [path.join(tmpDir, 'a.txt'), path.join(tmpDir, 'b.txt')];
      const responses = await runWorkerOverSocket(socketPath, socketNonce, [
        {
          ops: [
            {
              type: 'write-mv',
              targetPath: paths[0],
              contentB64: b64('aaa'),
              defaultMode: '0644',
            },
          ],
        },
        {
          ops: [
            {
              type: 'write-mv',
              targetPath: paths[1],
              contentB64: b64('bbb'),
              defaultMode: '0644',
            },
          ],
        },
      ]);
      expect(responses).toHaveLength(2);
      expect(responses[0].results[0].ok).toBe(true);
      expect(responses[1].results[0].ok).toBe(true);
      expect(fs.readFileSync(paths[0], 'utf8')).toBe('aaa');
      expect(fs.readFileSync(paths[1], 'utf8')).toBe('bbb');
    });
  },
);
