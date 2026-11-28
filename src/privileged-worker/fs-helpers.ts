/** Low-level filesystem helpers shared by the privileged worker op handlers. */
import * as crypto from 'crypto';
import * as fs from 'fs';

// O_NOFOLLOW and O_NONBLOCK are POSIX-only; fall back to 0 (no-op) on platforms
// where they are not defined (Windows). The worker is only invoked via sudo on
// Unix, so 0 is never reached in production.
export const O_NOFOLLOW: number =
  (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
export const O_NONBLOCK: number =
  (fs.constants as Record<string, number>).O_NONBLOCK ?? 0;

// Base64 encoding inflates raw bytes by ~33%, so a 100 MiB file produces
// ~133 MiB of base64 in the JSON response. runPrivilegedWorker uses spawnSync
// with maxBuffer = 150 MiB — a single-file batch fits, but multi-file batches
// whose combined base64 output exceeds ~113 MiB will overflow and throw
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Use SudoWorkerSession for large
// multi-file read batches; it streams via readline with a separate 500 MiB
// per-response cap and no fixed maxBuffer.
export const MAX_READ = 100 * 1024 * 1024;

export function randomHex(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** Permission bits of a stat mode as a 4-digit octal string, e.g. "0644". */
export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** ENOENT, ELOOP and ENOTDIR: the path is absent or not a reachable file. */
export function isAbsentOrNotFile(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
}

export function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // best-effort close
  }
}

export function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort cleanup
  }
}

function readLimitError(label: string, resolvedPath: string): Error {
  return new Error(`${label}: ${resolvedPath} exceeds the 100 MiB read limit`);
}

function assertReadableRegularFile(
  st: fs.Stats,
  label: string,
  resolvedPath: string,
): void {
  if (!st.isFile()) {
    // Attach a recognisable code so callers can distinguish directory
    // (EISDIR) from other special files like FIFOs or sockets (ENOTREGFILE).
    // Without a code, callers would mis-report the path as non-existent.
    const err = Object.assign(
      new Error(`${label}: ${resolvedPath} is not a regular file`),
      { code: st.isDirectory() ? 'EISDIR' : 'ENOTREGFILE' },
    );
    throw err;
  }
  if (st.size > MAX_READ) {
    throw readLimitError(label, resolvedPath);
  }
}

function readToEnd(fd: number, label: string, resolvedPath: string): Buffer {
  // Read until EOF rather than st.size bytes: st.size may be 0 for special
  // filesystems (procfs, sysfs) and also for empty regular files. Reading
  // until EOF handles both cases correctly.
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.alloc(65536);
  let n: number;
  while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
    total += n;
    if (total > MAX_READ) {
      throw readLimitError(label, resolvedPath);
    }
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

// Opens resolvedPath with O_RDONLY|O_NOFOLLOW|O_NONBLOCK, verifies it is a
// regular file within the MAX_READ limit, reads it fully, and returns the
// base64-encoded contents and the file's permission bits (octal string, e.g.
// "0644"). The label ('read' or 'stat-read') is used in error messages. The fd
// is always closed, even on error. Mode is captured via fstatSync while the fd
// is still open — atomically bound to the same inode as the content being read.
export function readFileToBase64(
  resolvedPath: string,
  label: string,
): { contentB64: string; mode: string } {
  let fd: number | undefined;
  try {
    // O_NONBLOCK omitted: a regular-file readSync (below) can return EAGAIN
    // on NFS/FUSE when O_NONBLOCK is set. The fstatSync check below already
    // rejects FIFOs and other non-regular files before any read is attempted.
    fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    assertReadableRegularFile(st, label, resolvedPath);
    const mode = formatMode(st.mode);
    const content = readToEnd(fd, label, resolvedPath);
    return { contentB64: content.toString('base64'), mode };
  } finally {
    closeQuietly(fd);
  }
}

export function getExistingMode(filePath: string): string | undefined {
  try {
    const lst = fs.lstatSync(filePath);
    // For symlinks, follow to the target to preserve the target file's mode
    // (matching the old `stat -L` behavior). If the target is not a regular
    // file or the link is dangling, return undefined so the caller falls back
    // to defaultMode.
    const stat = lst.isSymbolicLink() ? fs.statSync(filePath) : lst;
    if (!stat.isFile()) return undefined;
    const rawMode = stat.mode & 0o7777;
    // Strip setuid/setgid/sticky when the source was a symlink: the replacement
    // is a new regular file and the worker runs as root, so inheriting those
    // bits from the symlink target would silently create a setuid/setgid binary.
    const strippedMode = lst.isSymbolicLink() ? rawMode & 0o0777 : rawMode;
    return formatMode(strippedMode);
  } catch (e) {
    // ENOENT: file doesn't exist yet → use defaultMode (expected, suppress).
    // ELOOP/ENOTDIR: target is a broken symlink or non-dir component → skip.
    // EACCES/EPERM: even root was denied (SELinux/AppArmor MAC policy) →
    //   rethrow so the caller doesn't silently reset the file's mode.
    if (isAbsentOrNotFile(errnoCode(e))) return undefined;
    throw e;
  }
}

// parseInt('0o644', 8) stops at 'o' and returns 0, silently setting permissions
// to 0000. Strip the prefix so both '0644' and '0o644' parse correctly.
export function parseMode(modeStr: string): number {
  const stripped = modeStr.replace(/^0[oO]/, '');
  // Validate before parsing: parseInt stops at the first non-octal character
  // and returns the partial result (e.g. "644abc" → 420), which would
  // silently set wrong permissions. The isNaN guard only catches the case
  // where the FIRST character is invalid.
  if (!/^[0-7]+$/.test(stripped)) throw new Error(`invalid mode: ${modeStr}`);
  return parseInt(stripped, 8);
}

// Buffer.from(str, 'base64') silently drops invalid characters, which can
// silently corrupt content if contentB64 is truncated (e.g. by a short-write
// on the stdin pipe). Validate before decoding so the op fails loudly.
// Use a regex + length check rather than the round-trip Buffer approach: the
// round-trip (decode then re-encode) allocates two extra buffers the size of
// the input, which for a 10 MiB file means ~27 MiB of garbage per call. For a
// batch of 20 large files this peaks at ~540 MiB before any write starts.
// The regex + length check is O(n) with zero extra allocation:
//   - `^[A-Za-z0-9+/]*={0,2}$` ensures only valid base64 chars and at most 2
//     trailing `=` signs (so "A===" and "AAAA====" are correctly rejected).
//   - `s.length % 4 !== 0` rejects strings that aren't padded to a 4-char
//     boundary (so bare "AA" and "AAA" are correctly rejected).
// Together these two checks accept exactly canonical standard base64, which is
// also what Buffer.from(s,'base64').toString('base64') round-trips correctly.
export function validateBase64(s: string, field: string): void {
  // Empty string is valid: it encodes an empty file (.gitkeep, empty __init__.py, etc.).
  if (s === '') return;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new Error(`${field}: invalid base64 string (length ${s.length})`);
  }
}

// fs.fchmodSync is not implemented on Windows — no-op there since the worker
// only ever runs under sudo on Unix.
export function safeFchmodSync(fd: number, mode: number): void {
  if (process.platform !== 'win32') {
    fs.fchmodSync(fd, mode);
  }
}

/**
 * Throws `message` when resolvedPath is an existing directory (not following
 * symlinks). A missing path is fine; any other lstat error propagates.
 */
export function refuseDirectory(resolvedPath: string, message: string): void {
  try {
    if (fs.lstatSync(resolvedPath).isDirectory()) {
      throw new Error(message);
    }
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e;
  }
}
