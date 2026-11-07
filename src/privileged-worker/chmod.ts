/** chmod: change permissions through an fd wherever possible (TOCTOU-free). */
import * as fs from 'fs';
import * as path from 'path';
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  closeQuietly,
  errnoCode,
  parseMode,
  safeFchmodSync,
} from './fs-helpers';
import type { ChmodOp, DispatchResult } from './types';

// O_PATH open errors that fall back to the path-based chmod: O_PATH is
// genuinely unavailable (ENOTSUP/ENOSYS on older kernels) or permission was
// denied (EACCES/EPERM). Resource errors such as EMFILE or ENOMEM indicate a
// system problem unrelated to the TOCTOU concern and must not silently take
// the racy path-based fallback.
const O_PATH_FALLBACK_CODES = new Set<string | undefined>([
  'ENOTSUP',
  'ENOSYS',
  'EACCES',
  'EPERM',
]);

type ChmodOpen = { fd: number } | { denied: unknown };

// Opens the target O_RDONLY, falling back to O_WRONLY on EACCES. When both are
// denied with EACCES, returns the second error instead of an fd.
function openForChmod(resolvedPath: string): ChmodOpen {
  try {
    return {
      fd: fs.openSync(
        resolvedPath,
        fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      ),
    };
  } catch (e) {
    if (errnoCode(e) !== 'EACCES') throw e;
  }
  try {
    return {
      fd: fs.openSync(
        resolvedPath,
        fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
      ),
    };
  } catch (e2) {
    if (errnoCode(e2) !== 'EACCES') throw e2;
    return { denied: e2 };
  }
}

function notRegularFile(op: ChmodOp, cause: unknown): Error {
  return new Error(`chmod: ${op.targetPath} is not a regular file`, { cause });
}

// Opens an O_PATH fd (Linux ≥ 2.6.39), which needs no permission on the file.
// Returns undefined when O_PATH is unavailable on this platform or the open
// failed with one of O_PATH_FALLBACK_CODES.
function openPathFd(
  op: ChmodOp,
  resolvedPath: string,
  cause: unknown,
): number | undefined {
  const O_PATH_FLAG = (fs.constants as Record<string, number>).O_PATH ?? 0;
  if (O_PATH_FLAG === 0) return undefined;
  let pathFd: number;
  try {
    pathFd = fs.openSync(resolvedPath, O_PATH_FLAG | O_NOFOLLOW);
  } catch (e) {
    if (!O_PATH_FALLBACK_CODES.has(errnoCode(e))) throw e;
    return undefined;
  }
  // On Linux, O_PATH | O_NOFOLLOW opens the symlink inode itself
  // instead of returning ELOOP. If the target was raced from a
  // regular file to a symlink between the earlier lstatSync and
  // this O_PATH open, pathFd refers to the symlink — and
  // chmodSync('/proc/self/fd/<n>') would follow it to an
  // unintended target. Verify via fstat before using the fd.
  const pathSt = fs.fstatSync(pathFd);
  if (!pathSt.isFile()) {
    fs.closeSync(pathFd);
    throw notRegularFile(op, cause);
  }
  return pathFd;
}

// Returns true when the chmod went through /proc/self/fd/<pathFd>. Always
// closes pathFd.
function chmodViaProcFd(pathFd: number, mode: string): boolean {
  try {
    // /proc/self/fd/<fd> dereferences the file-description directly
    // in the kernel without re-traversing the filesystem path, giving
    // a TOCTOU-free chmod even when fchmod(O_PATH_fd) fails with
    // EBADF on Linux. Falls back to the path-based chmod below if
    // procfs is unavailable (containers, non-Linux platforms).
    fs.chmodSync(`/proc/self/fd/${pathFd}`, parseMode(mode));
    return true;
  } catch {
    // procfs unavailable or not Linux — fall through to path-based
    // chmod with lstat pre-flight below.
    return false;
  } finally {
    fs.closeSync(pathFd);
  }
}

// Both O_RDONLY and O_WRONLY failed (e.g. mode-0000 file, or root
// blocked by a MAC policy). Use O_PATH (Linux ≥ 2.6.39) to obtain
// a no-permission-required fd for a TOCTOU-free fchmod. Fall back
// to a path-based chmod with a pre-flight lstat guard on platforms
// that lack O_PATH (macOS, Windows).
function chmodWithoutFd(
  op: ChmodOp,
  resolvedPath: string,
  cause: unknown,
): void {
  const pathFd = openPathFd(op, resolvedPath, cause);
  if (pathFd !== undefined && chmodViaProcFd(pathFd, op.mode)) return;
  // Narrow the TOCTOU window: verify it is still a regular file
  // immediately before the path-based chmod.
  const lst = fs.lstatSync(resolvedPath);
  if (!lst.isFile()) {
    throw notRegularFile(op, cause);
  }
  fs.chmodSync(resolvedPath, parseMode(op.mode));
}

export function handleChmod(op: ChmodOp): DispatchResult {
  const resolvedPath = path.resolve(op.targetPath);
  let fd: number | undefined;
  try {
    const opened = openForChmod(resolvedPath);
    if ('denied' in opened) {
      chmodWithoutFd(op, resolvedPath, opened.denied);
    } else {
      fd = opened.fd;
      safeFchmodSync(fd, parseMode(op.mode));
      fs.closeSync(fd);
      fd = undefined;
    }
  } catch (e) {
    closeQuietly(fd);
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'ELOOP') return { kind: 'skipped' };
    throw e;
  }
  return { kind: 'ok' };
}
