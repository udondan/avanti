/** Built-in per-file, date and system variables. */
import * as path from 'path';
import { Variables } from '../types';

// Build the per-file path variables for a resolved absolute target path.
export function buildFileVars(targetPath: string): Variables {
  const filename = path.basename(targetPath);
  const ext = path.extname(targetPath).replace(/^\./, '');
  const basename = ext ? filename.slice(0, -(ext.length + 1)) : filename;
  const dirname = path.dirname(targetPath);
  return Object.assign(Object.create(null) as Variables, {
    path: targetPath,
    filename,
    basename,
    ext,
    dirname,
    basedir: path.basename(dirname),
  });
}

// Build date/datetime variables from a given Date (defaults to now).
export function buildDateVars(now: Date = new Date()): Variables {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-');
  const datetime = [
    date,
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
  return Object.assign(Object.create(null) as Variables, { date, datetime });
}

// Build system variables reflecting the machine running avanti.
// $os      — linux | darwin | windows (win32 is normalised to windows)
// $arch    — x86_64 | arm64 | i686 | arm  (GNU-triple / Rust tool naming)
// $arch_go — amd64  | arm64 | 386   | arm  (Go / Docker / Kubernetes naming)
// Unknown platform/arch values are passed through as-is.
export function buildSystemVars(): Variables {
  const osMap: Record<string, string> = {
    linux: 'linux',
    darwin: 'darwin',
    win32: 'windows',
  };
  const archMap: Record<string, string> = {
    x64: 'x86_64',
    arm64: 'arm64',
    ia32: 'i686',
    arm: 'arm',
  };
  const archGoMap: Record<string, string> = {
    x64: 'amd64',
    arm64: 'arm64',
    ia32: '386',
    arm: 'arm',
  };
  const platform = process.platform as string;
  const nodeArch = process.arch as string;
  return Object.assign(Object.create(null) as Variables, {
    os: osMap[platform] ?? platform,
    arch: archMap[nodeArch] ?? nodeArch,
    arch_go: archGoMap[nodeArch] ?? nodeArch,
  });
}
