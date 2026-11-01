// Loads the CLI entry point in-process with a controlled argv to check the
// global options and the --verbose pre-action hook.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let prevArgv: string[];
let prevHistoryDir: string | undefined;

async function loadCli(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...a) => void out.push(a.join(' ')));
  process.argv = ['node', 'avanti', ...args];
  vi.resetModules();
  try {
    await import('../src/cli');
  } finally {
    log.mockRestore();
  }
  return out.join('\n');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'avanti-cli-'));
  prevArgv = process.argv;
  prevHistoryDir = process.env.AVANTI_HISTORY_DIR;
  process.env.AVANTI_HISTORY_DIR = tmpDir;
});

afterEach(() => {
  process.argv = prevArgv;
  if (prevHistoryDir === undefined) delete process.env.AVANTI_HISTORY_DIR;
  else process.env.AVANTI_HISTORY_DIR = prevHistoryDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cli', () => {
  it('runs a subcommand without enabling verbose output', async () => {
    const out = await loadCli([
      '--config',
      join(tmpDir, 'avanti.yml'),
      '--working-dir',
      tmpDir,
      'log',
    ]);
    expect(out).toContain('No history recorded yet.');
    const { isVerbose } = await import('../src/logger');
    expect(isVerbose()).toBe(false);
  });

  it('enables verbose output with --verbose', async () => {
    const out = await loadCli([
      '--verbose',
      '--config',
      join(tmpDir, 'avanti.yml'),
      '--working-dir',
      tmpDir,
      'log',
    ]);
    expect(out).toContain('No history recorded yet.');
    const { isVerbose } = await import('../src/logger');
    expect(isVerbose()).toBe(true);
  });
});
