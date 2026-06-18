import { execSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '../src/cli.ts');
const PROJECT_ROOT = resolve(__dirname, '..');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let tmpDir: string;
let historyDir: string;

function run(
  subcommand: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  try {
    const stdout = execSync(
      `bunx tsx "${CLI}" --config "${join(tmpDir, 'avanti.yml')}" --working-dir "${tmpDir}" ${subcommand}`,
      {
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
        env: { ...process.env, AVANTI_HISTORY_DIR: historyDir, ...extraEnv },
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

function runFromDir(dir: string, subcommand: string): RunResult {
  try {
    const stdout = execSync(`bunx tsx "${CLI}" ${subcommand}`, {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, AVANTI_HISTORY_DIR: historyDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

function writeConfig(content: string): void {
  writeFileSync(join(tmpDir, 'avanti.yml'), content);
}

function writeSource(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content);
  return p;
}

function readOutput(name: string): string {
  return readFileSync(join(tmpDir, name), 'utf8');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-history-int-'));
  historyDir = join(tmpDir, '.history');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('history integration', () => {
  describe('pull records history', () => {
    it('creates history after a successful pull', { timeout: 15_000 }, () => {
      const src = writeSource('src.txt', 'hello');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);

      run('pull --yes');

      expect(existsSync(historyDir)).toBe(true);
    });

    it(
      'does not record history entry when nothing changed',
      { timeout: 15_000 },
      () => {
        const src = writeSource('src.txt', 'hello');
        writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);

        run('pull --yes');
        const { stdout: log1 } = run('log');
        expect(log1).toContain('pull ');

        // Second pull — no changes
        run('pull --yes');
        const { stdout: log2 } = run('log');
        // Still only one pull entry
        const pullCount = (log2.match(/^pull /gm) ?? []).length;
        expect(pullCount).toBe(1);
      },
    );
  });

  describe('avanti log', () => {
    it('shows "No history" when no pull has run', () => {
      writeConfig(`files:\n  ./out.txt:\n    src:\n      raw: hello\n`);
      const { stdout } = run('log');
      expect(stdout).toContain('No history recorded yet.');
    });

    it('shows pull entry after a pull', () => {
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);

      run('pull --yes');
      const { stdout } = run('log');
      expect(stdout).toMatch(/pull [0-9a-f]{8}/);
      expect(stdout).toContain('out.txt');
    });

    it('shows multiple pull entries newest first', { timeout: 15_000 }, () => {
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      writeFileSync(src, 'v2');
      run('pull --yes');

      const { stdout } = run('log');
      const lines = stdout.split('\n').filter((l) => l.startsWith('pull '));
      expect(lines).toHaveLength(2);
      // Newest pull (v2) should appear first
      expect(stdout.indexOf(lines[0])).toBeLessThan(stdout.indexOf(lines[1]));
    });

    it('shows (new file) label for newly created files', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      const { stdout } = run('log');
      expect(stdout).toContain('(new file)');
    });

    it('shows (modified) label for updated files', () => {
      writeSource('out.txt', 'original');
      const src = writeSource('src.txt', 'new content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      const { stdout } = run('log');
      expect(stdout).toContain('(modified)');
    });
  });

  describe('avanti log <file>', () => {
    it('shows "No history" for an untracked file', () => {
      writeConfig(`files:\n  ./out.txt:\n    src:\n      raw: hello\n`);
      const { stdout } = run('log out.txt');
      expect(stdout).toContain('No history for');
    });

    it('shows version history for a tracked file', () => {
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      writeFileSync(src, 'v2');
      run('pull --yes');

      const { stdout } = run(`log ${join(tmpDir, 'out.txt')}`);
      expect(stdout).toContain('v1');
      expect(stdout).toContain('v2');
      expect(stdout).toContain('(current)');
    });

    it('shows v0 when file existed before avanti', () => {
      writeSource('out.txt', 'pre-existing');
      const src = writeSource('src.txt', 'replaced');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      const { stdout } = run(`log ${join(tmpDir, 'out.txt')}`);
      expect(stdout).toContain('v0');
      expect(stdout).toContain('(original, before avanti)');
    });

    it('does not show v0 for files avanti created', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./new-file.txt:\n    src: ${src}\n`);
      run('pull --yes');

      const { stdout } = run(`log ${join(tmpDir, 'new-file.txt')}`);
      expect(stdout).not.toContain('(original, before avanti)');
      expect(stdout).toContain('v1');
    });
  });

  describe('avanti diff <pullId>', () => {
    it(
      'exits 0 when current files match the given pull state',
      { timeout: 15_000 },
      () => {
        const src = writeSource('src.txt', 'content');
        writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
        run('pull --yes');

        const { stdout: logOut } = run('log');
        const pullId = logOut.match(/pull ([0-9a-f]{8})/)?.[1] ?? '';
        expect(pullId).not.toBe('');

        const { exitCode } = run(`diff ${pullId}`);
        expect(exitCode).toBe(0);
      },
    );

    it(
      'exits 1 and shows diff when files differ from given pull state',
      { timeout: 15_000 },
      () => {
        const src = writeSource('src.txt', 'v1');
        writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
        run('pull --yes');

        const { stdout: logAfterFirst } = run('log');
        const firstPullId =
          logAfterFirst.match(/pull ([0-9a-f]{8})/)?.[1] ?? '';

        writeFileSync(src, 'v2');
        run('pull --yes');

        const { exitCode, stdout } = run(`diff ${firstPullId}`);
        expect(exitCode).toBe(1);
        expect(stdout).toContain('---');
        expect(stdout).toContain('+++');
      },
    );

    it('errors when pullId is not found', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      const { exitCode, stderr } = run('diff deadbeef');
      expect(exitCode).toBe(2);
      expect(stderr).toContain('No pull found');
    });
  });

  describe('avanti revert (no argument — undo last pull)', () => {
    it('restores file to state before last pull', () => {
      writeSource('out.txt', 'original');
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      expect(readOutput('out.txt')).toBe('v1');

      run('revert --yes');
      expect(readOutput('out.txt')).toBe('original');
    });

    it('deletes files avanti created when undoing the only pull', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./brand-new.txt:\n    src: ${src}\n`);
      run('pull --yes');
      expect(existsSync(join(tmpDir, 'brand-new.txt'))).toBe(true);

      run('revert --yes');
      expect(existsSync(join(tmpDir, 'brand-new.txt'))).toBe(false);
    });

    it('reverts to state after second-to-last pull when two pulls exist', () => {
      writeSource('out.txt', 'original');
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      writeFileSync(src, 'v2');
      run('pull --yes');
      expect(readOutput('out.txt')).toBe('v2');

      run('revert --yes');
      expect(readOutput('out.txt')).toBe('v1');
    });

    it(
      'handles repeated pull → revert cycles without getting stuck',
      { timeout: 30_000 },
      () => {
        const src = writeSource('src.txt', 'content');
        writeConfig(`files:\n  ./brand-new.txt:\n    src: ${src}\n`);

        // Cycle 3 times: pull (creates file) → revert (deletes file)
        for (let i = 0; i < 3; i++) {
          run('pull --yes');
          expect(existsSync(join(tmpDir, 'brand-new.txt'))).toBe(true);
          run('revert --yes');
          expect(existsSync(join(tmpDir, 'brand-new.txt'))).toBe(false);
        }

        // 4th pull must still detect a change and write the file
        const { stdout } = run('pull --yes');
        expect(stdout).not.toContain('No changes');
        expect(existsSync(join(tmpDir, 'brand-new.txt'))).toBe(true);
      },
    );

    it('prints "nothing to revert" when already at target state', () => {
      writeSource('out.txt', 'original');
      const src = writeSource('src.txt', 'v1');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      run('revert --yes');

      // Revert again — already at original state
      const { stdout } = run('revert --yes');
      expect(stdout).toContain('Nothing to revert');
    });
  });

  describe('avanti revert <pullId>', () => {
    it(
      'restores files to the state at the specified pull',
      { timeout: 15_000 },
      () => {
        writeSource('out.txt', 'original');
        const src = writeSource('src.txt', 'v1');
        writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
        run('pull --yes');

        const { stdout: logAfterFirst } = run('log');
        const firstPullId =
          logAfterFirst.match(/pull ([0-9a-f]{8})/)?.[1] ?? '';

        writeFileSync(src, 'v2');
        run('pull --yes');

        writeFileSync(src, 'v3');
        run('pull --yes');
        expect(readOutput('out.txt')).toBe('v3');

        // Revert to the first pull
        run(`revert ${firstPullId} --yes`);
        expect(readOutput('out.txt')).toBe('v1');
      },
    );

    it(
      'deletes files introduced after the target pull',
      { timeout: 15_000 },
      () => {
        const src1 = writeSource('src1.txt', 'content1');
        writeConfig(`files:\n  ./file1.txt:\n    src: ${src1}\n`);
        run('pull --yes');

        const { stdout: logAfterFirst } = run('log');
        const firstPullId =
          logAfterFirst.match(/pull ([0-9a-f]{8})/)?.[1] ?? '';

        const src2 = writeSource('src2.txt', 'content2');
        writeConfig(
          `files:\n  ./file1.txt:\n    src: ${src1}\n  ./file2.txt:\n    src: ${src2}\n`,
        );
        run('pull --yes');
        expect(existsSync(join(tmpDir, 'file2.txt'))).toBe(true);

        // Revert to first pull — file2.txt should be deleted
        run(`revert ${firstPullId} --yes`);
        expect(existsSync(join(tmpDir, 'file2.txt'))).toBe(false);
        expect(readOutput('file1.txt')).toBe('content1');
      },
    );

    it('errors for unknown pullId', () => {
      const src = writeSource('src.txt', 'x');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      const { exitCode, stderr } = run('revert deadbeef --yes');
      expect(exitCode).toBe(2);
      expect(stderr).toContain('No pull found');
    });
  });

  describe('avanti reset', () => {
    it('restores modified files to their original content', () => {
      writeSource('out.txt', 'original content');
      const src = writeSource('src.txt', 'avanti content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      expect(readOutput('out.txt')).toBe('avanti content');

      run('reset --yes');
      expect(readOutput('out.txt')).toBe('original content');
    });

    it('deletes files avanti created', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./created-by-avanti.txt:\n    src: ${src}\n`);
      run('pull --yes');
      expect(existsSync(join(tmpDir, 'created-by-avanti.txt'))).toBe(true);

      run('reset --yes');
      expect(existsSync(join(tmpDir, 'created-by-avanti.txt'))).toBe(false);
    });

    it('handles a mix of created and modified files', () => {
      writeSource('existing.txt', 'was here before');
      const srcExisting = writeSource(
        'src-existing.txt',
        'avanti replaced this',
      );
      const srcNew = writeSource('src-new.txt', 'brand new file');
      writeConfig(
        `files:\n  ./existing.txt:\n    src: ${srcExisting}\n  ./new.txt:\n    src: ${srcNew}\n`,
      );
      run('pull --yes');

      run('reset --yes');
      expect(readOutput('existing.txt')).toBe('was here before');
      expect(existsSync(join(tmpDir, 'new.txt'))).toBe(false);
    });

    it('prints "No history found" when history dir is missing', () => {
      writeConfig(`files:\n  ./out.txt:\n    src:\n      raw: x\n`);
      rmSync(historyDir, { recursive: true, force: true });
      const { stdout } = run('reset --yes');
      expect(stdout).toContain('No avanti history found');
    });

    it('prints "nothing to reset" when files are already at pre-avanti state', () => {
      writeSource('out.txt', 'original');
      const src = writeSource('src.txt', 'replaced');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');
      run('reset --yes');

      const { stdout } = run('reset --yes');
      expect(stdout).toContain('already at their pre-avanti state');
    });
  });

  describe('stale file detection during pull', () => {
    it('deletes a file avanti created when it disappears from source directory', () => {
      const srcDir = join(tmpDir, 'src-dir');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.txt'), 'file a');
      writeFileSync(join(srcDir, 'b.txt'), 'file b');

      writeConfig(`files:\n  ./out-dir/:\n    src: ${srcDir}\n`);
      run('pull --yes');
      expect(existsSync(join(tmpDir, 'out-dir', 'a.txt'))).toBe(true);
      expect(existsSync(join(tmpDir, 'out-dir', 'b.txt'))).toBe(true);

      // Remove b.txt from source directory
      rmSync(join(srcDir, 'b.txt'));
      run('pull --yes');

      expect(existsSync(join(tmpDir, 'out-dir', 'a.txt'))).toBe(true);
      expect(existsSync(join(tmpDir, 'out-dir', 'b.txt'))).toBe(false);
    });

    it('restores original content when a previously-existing file disappears from source', () => {
      const srcDir = join(tmpDir, 'src-dir');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.txt'), 'from source');

      // Pre-create b.txt so avanti tracks it as "existed before"
      writeFileSync(join(tmpDir, 'out-dir-b'), 'original b');
      // Use a single-file config pointing at out-dir-b directly
      writeSource('src-b.txt', 'avanti version of b');

      // First: pull two files
      writeConfig(
        `files:\n  ./out-dir/:\n    src: ${srcDir}\n  ./out-dir-b:\n    src: ${join(tmpDir, 'src-b.txt')}\n`,
      );
      run('pull --yes');
      expect(readOutput('out-dir-b')).toBe('avanti version of b');

      // Now remove the second entry from config (simulate it disappearing)
      writeConfig(`files:\n  ./out-dir/:\n    src: ${srcDir}\n`);
      run('pull --yes');

      // out-dir-b should be restored to original since it existed before avanti
      expect(readOutput('out-dir-b')).toBe('original b');
    });
  });

  describe('sudo stale-file cleanup', () => {
    it(
      'uses stored sudo identity to delete a stale file removed from config',
      { timeout: 25_000 },
      () => {
        // sudo is not available on Windows
        if (process.platform === 'win32') return;

        // Create a fake sudo binary that logs all invocations and passes real
        // commands through. sudo -v (the auth-cache refresh) exits 0 immediately
        // so no real privilege escalation is attempted.
        const fakeSudoLog = join(tmpDir, 'sudo-calls.log');
        const fakeSudoDir = join(tmpDir, 'fake-sudo');
        mkdirSync(fakeSudoDir, { recursive: true });
        const fakeSudoBin = join(fakeSudoDir, 'sudo');
        writeFileSync(
          fakeSudoBin,
          // Intercept stat calls used by the ancestor safety checks and return
          // safe values (mode 755, UID 0) so the test works under world-writable
          // tmpdir on Linux. All other commands are passed through unchanged.
          `#!/bin/sh\necho "$@" >> "${fakeSudoLog}"\n[ "$1" = "-v" ] && exit 0\nif [ "$1" = "stat" ]; then\n  case "$*" in\n    *%u*) echo "0"; exit 0 ;;\n    *%a*|*%Lp*) echo "755"; exit 0 ;;\n  esac\nfi\nexec "$@"\n`,
        );
        chmodSync(fakeSudoBin, 0o755);

        const sudoEnv = { PATH: `${fakeSudoDir}:${process.env.PATH ?? ''}` };

        // Pull with sudo: true — the file is tracked with its sudo identity.
        const src = writeSource('src.txt', 'privileged content');
        writeConfig(
          `files:\n  ./sudo-managed.txt:\n    src: ${src}\n    sudo: true\n`,
        );
        run('pull --yes', sudoEnv);

        const targetFile = join(tmpDir, 'sudo-managed.txt');
        expect(existsSync(targetFile)).toBe(true);
        // Confirm that sudo was actually invoked during the write (worker process).
        expect(existsSync(fakeSudoLog)).toBe(true);
        const pullCalls = readFileSync(fakeSudoLog, 'utf8');
        expect(pullCalls).toContain('privileged-worker.js');

        // Remove the entry from config and reset the call log.
        // The next pull's stale-cleanup should use the stored sudo identity to delete.
        rmSync(fakeSudoLog);
        writeConfig('files: {}');
        run('pull --yes', sudoEnv);

        // Stale cleanup must have called sudo rm to remove the tracked file.
        expect(existsSync(fakeSudoLog)).toBe(true);
        const cleanupCalls = readFileSync(fakeSudoLog, 'utf8');
        expect(cleanupCalls).toContain('rm');
        expect(existsSync(targetFile)).toBe(false);
      },
    );
  });

  describe('graceful degradation', () => {
    it('pull works even when history write fails (read-only dir)', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);

      // Point history at a path that can't be created (file in the way)
      writeFileSync(join(tmpDir, 'blocked'), 'not a dir');
      const { exitCode } = run('pull --yes', {
        AVANTI_HISTORY_DIR: join(tmpDir, 'blocked', 'subdir'),
      });
      expect(exitCode).toBe(0);
      expect(readOutput('out.txt')).toBe('content');
    });

    it('log shows "No history" when history dir was deleted', () => {
      const src = writeSource('src.txt', 'content');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);
      run('pull --yes');

      rmSync(historyDir, { recursive: true, force: true });
      const { stdout } = run('log');
      expect(stdout).toContain('No history recorded yet.');
    });
  });
});

describe('auto-detection — no --config / --working-dir flags', () => {
  it(
    'pull then log shows history when run from project dir without explicit flags',
    { timeout: 15_000 },
    () => {
      const src = writeSource('src.txt', 'hello');
      writeConfig(`files:\n  ./out.txt:\n    src: ${src}\n`);

      runFromDir(tmpDir, 'pull --yes');
      const { stdout } = runFromDir(tmpDir, 'log');

      expect(stdout).toMatch(/pull [0-9a-f]{8}/);
    },
  );

  it(
    'log without --config finds history recorded by pull with explicit --config',
    { timeout: 15_000 },
    () => {
      // Simulates the user running: avanti --config gitlab:... pull -y
      // then: avanti log  (no --config)
      // The two commands compute different hash keys unless log falls back to
      // a workingDir scan.
      const src = writeSource('src.txt', 'hello');
      const configPath = join(tmpDir, 'my-remote.yml');
      writeFileSync(configPath, `files:\n  ./out.txt:\n    src: ${src}\n`);

      // Pull with an explicit config path that log would never auto-detect
      runFromDir(tmpDir, `pull --yes --config "${configPath}"`);

      // Log without --config — auto-detection picks a different path
      const { stdout } = runFromDir(tmpDir, 'log');

      expect(stdout).toMatch(/pull [0-9a-f]{8}/);
    },
  );
});
