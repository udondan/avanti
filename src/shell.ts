import * as path from 'path';

export const isWindows = process.platform === 'win32';

// Absolute path to the inbox PowerShell on Windows.
// Using %SystemRoot% (rather than a bare 'powershell') prevents PATH-based
// command hijacking when avanti runs inside an untrusted working directory.
// We validate that SystemRoot is non-empty and absolute before trusting it;
// an empty or relative value would reintroduce the hijack risk.
const _sysRoot = process.env['SystemRoot'];
const _winRoot =
  _sysRoot && path.isAbsolute(_sysRoot) ? _sysRoot : 'C:\\Windows';
const POWERSHELL_EXE = path.join(
  _winRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

// Returns the shell binary + args needed to run a script string.
//
// On Windows: PowerShell is built into every Windows version since 7 — no
// external tools required. We pass the script as a Base64-encoded UTF-16LE
// command (-EncodedCommand) so command-line quoting is bypassed entirely.
// We also set UTF-8 I/O up front so non-ASCII content round-trips correctly.
//
// On Unix/macOS: plain sh -c.
export function getShellArgs(script: string): {
  shell: string;
  args: string[];
} {
  if (!isWindows) {
    return { shell: 'sh', args: ['-c', script] };
  }
  const wrapped =
    '[Console]::InputEncoding=[Text.Encoding]::UTF8;' +
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
    script;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return {
    shell: POWERSHELL_EXE,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
  };
}
