/** read, readlink and stat-read: return content (or link target) as base64. */
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_READ,
  errnoCode,
  formatMode,
  readFileToBase64,
} from './fs-helpers';
import type { DispatchResult, ReadOp, ReadlinkOp, StatReadOp } from './types';

export function handleRead(op: ReadOp): DispatchResult {
  const resolvedPath = path.resolve(op.targetPath);
  return {
    kind: 'read',
    contentB64: readFileToBase64(resolvedPath, 'read').contentB64,
    isSymlink: false,
  };
}

export function handleReadlink(op: ReadlinkOp): DispatchResult {
  const resolvedPath = path.resolve(op.targetPath);
  const target = fs.readlinkSync(resolvedPath);
  // PATH_MAX caps symlink targets at 4096 bytes on Linux/macOS, but NFS/CIFS
  // servers and crafted filesystems can exceed this. Guard consistently with
  // the read/stat-read paths so the parent cannot be OOM'd by a runaway target.
  if (target.length > MAX_READ) {
    throw new Error(
      `readlink: ${resolvedPath} target exceeds the 100 MiB read limit`,
    );
  }
  return {
    kind: 'read',
    contentB64: Buffer.from(target).toString('base64'),
    isSymlink: true,
  };
}

function readRegular(resolvedPath: string): DispatchResult {
  // readFileToBase64 captures the mode via fstatSync while the fd is
  // still open — atomically bound to the same inode as the content read.
  const { contentB64, mode } = readFileToBase64(resolvedPath, 'stat-read');
  return { kind: 'read', contentB64, isSymlink: false, mode };
}

// Captures the symlink's own mode bits for permission-drift detection.
// lstatSync shares the same TOCTOU window as readlinkSync (both are
// path-based). A failure here is mode-unknown, not an error.
function symlinkMode(resolvedPath: string): string | undefined {
  try {
    const slst = fs.lstatSync(resolvedPath);
    if (slst.isSymbolicLink()) {
      return formatMode(slst.mode);
    }
  } catch {
    // best-effort
  }
  return undefined;
}

function readSymlink(resolvedPath: string): DispatchResult {
  // readlinkSync is path-based and has a narrow TOCTOU window: a
  // concurrent privileged process could replace the symlink between the
  // ELOOP above and this call, causing us to return a stale or attacker-
  // supplied target. Running as root amplifies the consequence (wrong
  // content captured for history/v0). This race is intentionally accepted:
  // eliminating it requires readlinkat(2) via an O_PATH fd, which Node.js
  // does not expose without native code. stat-read results are advisory
  // (pre-read for history); no write depends on them being race-free.
  // If the path was replaced with a regular file in that window, readlinkSync
  // throws EINVAL — retry readFileToBase64 so the caller sees a regular file.
  try {
    const target = fs.readlinkSync(resolvedPath);
    return {
      kind: 'read',
      contentB64: Buffer.from(target).toString('base64'),
      isSymlink: true,
      mode: symlinkMode(resolvedPath),
    };
  } catch (e2) {
    if (errnoCode(e2) !== 'EINVAL') throw e2;
    return readRegular(resolvedPath);
  }
}

export function handleStatRead(op: StatReadOp): DispatchResult {
  const resolvedPath = path.resolve(op.targetPath);
  // readFileToBase64 opens with O_NOFOLLOW. If the path is (or becomes) a
  // symlink we get ELOOP; read the link target and return it as a symlink.
  // This is both simpler and eliminates the TOCTOU window that an initial
  // lstatSync would introduce.
  try {
    return readRegular(resolvedPath);
  } catch (e) {
    if (errnoCode(e) !== 'ELOOP') throw e;
    return readSymlink(resolvedPath);
  }
}
