import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

// shell.ts reads process.platform and %SystemRoot% at import time, so each
// test re-imports the module with a stubbed environment.

const realPlatform = process.platform;
const realSystemRoot = process.env['SystemRoot'];

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

async function loadWithPlatform(
  platform: string,
  systemRoot: string | undefined,
): Promise<{
  shell: typeof import('../src/shell');
  on: typeof import('../src/processors/on');
}> {
  setPlatform(platform);
  if (systemRoot === undefined) delete process.env['SystemRoot'];
  else process.env['SystemRoot'] = systemRoot;
  vi.resetModules();
  const shell = await import('../src/shell');
  const on = await import('../src/processors/on');
  return { shell, on };
}

afterEach(() => {
  setPlatform(realPlatform);
  if (realSystemRoot === undefined) delete process.env['SystemRoot'];
  else process.env['SystemRoot'] = realSystemRoot;
  vi.resetModules();
});

// A SystemRoot that is absolute on every platform but does not exist, so the
// derived powershell.exe path can never be spawned.
const BOGUS_ROOT = path.join(os.tmpdir(), 'avanti-no-such-windows-root');

describe('getShellArgs', () => {
  it('uses sh -c on non-Windows platforms', async () => {
    const { shell } = await loadWithPlatform('linux', undefined);
    expect(shell.isWindows).toBe(false);
    expect(shell.getShellArgs('echo hi')).toEqual({
      shell: 'sh',
      args: ['-c', 'echo hi'],
    });
  });

  it('uses PowerShell under %SystemRoot% with an encoded command on Windows', async () => {
    const { shell } = await loadWithPlatform('win32', BOGUS_ROOT);
    expect(shell.isWindows).toBe(true);
    const result = shell.getShellArgs('Write-Output hi');
    expect(result.shell).toBe(
      path.join(
        BOGUS_ROOT,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
    );
    expect(result.args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    const decoded = Buffer.from(result.args[3], 'base64').toString('utf16le');
    expect(decoded).toBe(
      '[Console]::InputEncoding=[Text.Encoding]::UTF8;' +
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
        '& {Write-Output hi}',
    );
  });

  it('falls back to C:\\Windows when %SystemRoot% is not absolute', async () => {
    const { shell } = await loadWithPlatform('win32', 'relative\\root');
    expect(shell.getShellArgs('x').shell).toBe(
      path.join(
        'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
    );
  });
});

describe('hooks on Windows (stubbed)', () => {
  it('applyWriteHook reports spawn failures', async () => {
    const { on } = await loadWithPlatform('win32', BOGUS_ROOT);
    expect(() => on.applyWriteHook('content', 'Write-Output hi')).toThrow(
      'on.write script failed to spawn',
    );
  });

  it('runHook prepends env-var prelude and reports spawn failures', async () => {
    const { on } = await loadWithPlatform('win32', BOGUS_ROOT);
    expect(() =>
      on.runHook('Write-Output $AVANTI_TARGET', { AVANTI_TARGET: 'x' }),
    ).toThrow('hook script failed to spawn');
  });
});
