import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkerResponse } from '../src/privileged-worker';

// Exercises the worker's entry point (argument parsing, nonce checks, request
// validation and crash reporting) by spawning dist/privileged-worker.js.
// Conditions that cannot be produced from outside the process (a TTY on stdin,
// running as root, a throwing stdout, stray rejections) are simulated with a
// small script preloaded via `node --require`.
const WORKER = path.resolve(__dirname, '../dist/privileged-worker.js');
const workerExists = fs.existsSync(WORKER);
const isWindows = process.platform === 'win32';

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `avanti-cli-test-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function b64(content: string): string {
  return Buffer.from(content).toString('base64');
}

interface RunOptions {
  args?: string[];
  input?: string;
  env?: Record<string, string | undefined>;
  preload?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(opts: RunOptions = {}): RunResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const nodeArgs: string[] = [];
  if (opts.preload !== undefined) {
    const preloadPath = path.join(tmpDir, 'preload.js');
    fs.writeFileSync(preloadPath, opts.preload);
    nodeArgs.push('--require', preloadPath);
  }
  const r = spawnSync('node', [...nodeArgs, WORKER, ...(opts.args ?? [])], {
    input: opts.input ?? '',
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Sends `lines` over stdin preceded by a valid nonce line.
function runStdin(
  lines: unknown[],
  opts: Omit<RunOptions, 'input'> = {},
): RunResult {
  const nonce = crypto.randomBytes(32).toString('hex');
  return run({
    ...opts,
    input: [nonce, ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n',
    env: { AVANTI_WORKER_NONCE: nonce, ...opts.env },
  });
}

function parse(stdout: string): WorkerResponse {
  return JSON.parse(stdout.trim().split('\n')[0]) as WorkerResponse;
}

describe.skipIf(isWindows || !workerExists)('worker entry point', () => {
  describe('stdin mode', () => {
    it('refuses to read ops from a TTY', () => {
      const r = run({
        preload:
          "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/stdin is a TTY/);
    });

    it('requires AVANTI_WORKER_NONCE', () => {
      const r = run({
        input: 'anything\n',
        env: { AVANTI_WORKER_NONCE: undefined },
      });
      expect(r.status).toBe(1);
      expect(parse(r.stdout).results).toEqual([
        {
          ok: false,
          error: 'stdin mode requires AVANTI_WORKER_NONCE to be set',
        },
      ]);
    });

    it('rejects a wrong nonce', () => {
      const r = run({
        input: 'wrong\n{"ops":[]}\n',
        env: { AVANTI_WORKER_NONCE: 'right' },
      });
      expect(r.status).toBe(1);
      expect(parse(r.stdout).results[0].error).toBe('stdin nonce mismatch');
    });

    it('ignores blank lines between requests', () => {
      const nonce = 'n'.repeat(16);
      const r = run({
        input: `${nonce}\n\n{"ops":[]}\n`,
        env: { AVANTI_WORKER_NONCE: nonce },
      });
      expect(r.status).toBe(0);
      expect(parse(r.stdout)).toEqual({ results: [] });
    });

    it('rejects a request whose ops is not an array', () => {
      const r = runStdin([{ ops: 1 }]);
      expect(r.status).toBe(1);
      expect(parse(r.stdout).results[0].error).toBe(
        'invalid request: ops must be an array',
      );
    });

    it('rejects batches above the maximum size and pads every slot', () => {
      const r = runStdin([{ ops: Array.from({ length: 10_001 }, () => ({})) }]);
      expect(r.status).toBe(1);
      const { results } = parse(r.stdout);
      expect(results).toHaveLength(10_001);
      expect(results[0].error).toMatch(/exceeds maximum batch size of 10000/);
      expect(results[1].error).toBe('worker exited before processing this op');
    });

    it('validates op fields before dispatching', () => {
      const t = path.join(tmpDir, 'x');
      const ops: unknown[] = [
        null,
        { targetPath: t },
        { type: 'delete' },
        { type: 'delete', targetPath: 'relative/path' },
        { type: 'delete', targetPath: `${tmpDir}/a/../b` },
        { type: 'write-mv', targetPath: t, backupPath: 'rel.bak' },
        { type: 'write-mv', targetPath: t, defaultMode: '0644' },
        { type: 'write-in-place', targetPath: t, contentB64: '' },
        { type: 'write-symlink', targetPath: t },
        { type: 'chmod', targetPath: t },
      ];
      const r = runStdin([{ ops, continueOnError: true }]);
      expect(r.status).toBe(0);
      expect(parse(r.stdout).results.map((x) => x.error)).toEqual([
        'invalid op: expected object, got object',
        'invalid op: missing required field "type"',
        'invalid op delete: missing required field "targetPath"',
        'invalid op delete: targetPath must be absolute, got relative/path',
        `invalid op delete: targetPath must be canonical (no .. components), got ${tmpDir}/a/../b`,
        'invalid op write-mv: backupPath must be absolute, got rel.bak',
        'invalid op write-mv: missing required field "contentB64"',
        'invalid op write-in-place: missing required field "defaultMode"',
        'invalid op write-symlink: missing required field "symlinkTarget"',
        'invalid op chmod: missing required field "mode"',
      ]);
    });

    it('checks backup ancestors, reports skipped ops and includes stat-read modes', () => {
      const target = path.join(tmpDir, 'f.txt');
      fs.writeFileSync(target, 'old');
      const backupPath = path.join(tmpDir, 'bk', 'f.txt.bak');
      const r = runStdin([
        {
          ops: [
            {
              type: 'write-mv',
              targetPath: target,
              contentB64: b64('new'),
              defaultMode: '0644',
              backupPath,
            },
            {
              type: 'chmod',
              targetPath: path.join(tmpDir, 'missing'),
              mode: '0600',
            },
            { type: 'stat-read', targetPath: target },
          ],
        },
      ]);
      expect(r.status).toBe(0);
      const { results } = parse(r.stdout);
      expect(results[0]).toEqual({ ok: true });
      expect(results[1]).toEqual({ ok: true, skipped: true });
      expect(results[2]).toMatchObject({ ok: true, mode: '0644' });
      expect(fs.readFileSync(backupPath, 'utf8')).toBe('old');
    });

    it('trusts the invoking user from SUDO_UID', () => {
      const target = path.join(tmpDir, 'f.txt');
      const r = runStdin(
        [
          {
            ops: [
              {
                type: 'write-mv',
                targetPath: target,
                contentB64: b64('x'),
                defaultMode: '0644',
              },
            ],
          },
        ],
        { env: { SUDO_UID: String(process.getuid?.() ?? 0) } },
      );
      expect(r.status).toBe(0);
      expect(parse(r.stdout).results[0].ok).toBe(true);
    });

    it('refuses to run as root when SUDO_UID was stripped', () => {
      const r = run({
        preload: 'process.getuid = () => 0;',
        env: { SUDO_UID: undefined },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/SUDO_UID is not set/);
    });
  });

  describe('crash reporting', () => {
    // Makes the first write of a batch response throw (inside the readline
    // line handler, so it surfaces as an uncaught exception). With `always`,
    // every response write throws, including the crash report itself.
    function throwingStdout(always: boolean): string {
      return `
        const orig = process.stdout.write.bind(process.stdout);
        let thrown = false;
        process.stdout.write = (chunk, ...rest) => {
          if (${always} || !thrown) {
            thrown = true;
            throw new Error('stdout exploded');
          }
          return orig(chunk, ...rest);
        };`;
    }

    it('reports completed results plus a crash sentinel on an uncaught exception', () => {
      const target = path.join(tmpDir, 'f.txt');
      fs.writeFileSync(target, 'x');
      const r = runStdin([{ ops: [{ type: 'delete', targetPath: target }] }], {
        preload: throwingStdout(false),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/uncaught exception: .*stdout exploded/);
      expect(parse(r.stdout).results).toEqual([
        { ok: true },
        { ok: false, error: 'stdout exploded' },
      ]);
    });

    it('still exits non-zero when the crash report cannot be written', () => {
      const r = runStdin([{ ops: [] }], { preload: throwingStdout(true) });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
    });

    it('reports non-Error uncaught exceptions', () => {
      const r = run({
        preload: "setTimeout(() => { throw 'plain string'; }, 0);",
        env: { AVANTI_WORKER_NONCE: 'n' },
      });
      expect(r.status).toBe(1);
      expect(parse(r.stdout).results).toEqual([
        { ok: false, error: 'plain string' },
      ]);
    });

    it('reports unhandled rejections', () => {
      const r = run({
        preload:
          "setTimeout(() => { void Promise.reject(new Error('rejected')); }, 0);",
        env: { AVANTI_WORKER_NONCE: 'n' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/unhandled rejection: rejected/);
      expect(parse(r.stdout).results[0].error).toBe('rejected');
    });

    it('reports non-Error unhandled rejections', () => {
      const r = run({
        preload: 'setTimeout(() => { void Promise.reject(42); }, 0);',
        env: { AVANTI_WORKER_NONCE: 'n' },
      });
      expect(r.status).toBe(1);
      expect(parse(r.stdout).results[0].error).toBe('42');
    });
  });

  describe('--req-file mode', () => {
    it('reads a single request from the file and unlinks it', () => {
      const target = path.join(tmpDir, 'out.txt');
      const reqFile = path.join(tmpDir, 'req.json');
      fs.writeFileSync(
        reqFile,
        JSON.stringify({
          ops: [
            {
              type: 'write-mv',
              targetPath: target,
              contentB64: b64('from file'),
              defaultMode: '0644',
            },
          ],
        }) + '\n',
      );
      const r = run({ args: [`--req-file=${reqFile}`] });
      expect(r.status).toBe(0);
      expect(parse(r.stdout).results).toEqual([{ ok: true }]);
      expect(fs.readFileSync(target, 'utf8')).toBe('from file');
      expect(fs.existsSync(reqFile)).toBe(false);
    });

    it('reports a data channel error when the file cannot be opened', () => {
      const r = run({
        args: [`--req-file=${path.join(tmpDir, 'missing.json')}`],
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/data channel error: .*ENOENT/);
      expect(parse(r.stdout).results[0].error).toMatch(/ENOENT/);
    });
  });

  describe('--socket-path mode', () => {
    it('exits when AVANTI_WORKER_NONCE is missing', () => {
      const r = run({
        args: [`--socket-path=${path.join(tmpDir, 'none.sock')}`],
        env: { AVANTI_WORKER_NONCE: undefined },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/AVANTI_WORKER_NONCE is not set/);
    });

    it('sends the crash report over the socket and closes it', async () => {
      const socketPath = path.join(tmpDir, 'w.sock');
      const nonce = crypto.randomBytes(16).toString('hex');
      const lines: string[] = [];
      const server = net.createServer();
      const done = new Promise<number | null>((resolve, reject) => {
        server.on('connection', (socket) => {
          const rl = readline.createInterface({ input: socket });
          rl.on('line', (line) => {
            lines.push(line);
            if (lines.length === 1) {
              socket.write(
                JSON.stringify({
                  ops: Array.from({ length: 10_001 }, () => ({})),
                }) + '\n',
              );
            }
          });
        });
        server.listen(socketPath, () => {
          const proc = spawn('node', [WORKER, `--socket-path=${socketPath}`], {
            env: { ...process.env, AVANTI_WORKER_NONCE: nonce },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          proc.on('error', reject);
          proc.on('close', resolve);
        });
      });
      const code = await done;
      server.close();
      expect(code).toBe(1);
      expect(lines[0]).toBe(nonce);
      const resp = JSON.parse(lines[1]) as WorkerResponse;
      expect(resp.results[0].error).toMatch(/exceeds maximum batch size/);
    });
  });
});
