/** World-traversable temp directory used for staged workers and IPC sockets. */
import * as fs from 'fs';
import * as os from 'os';

// os.tmpdir() may return a per-user private path on macOS (/var/folders/…)
// whose ancestor directories are not world-traversable, so a named sudo user
// cannot reach files placed there. /tmp is always world-executable on Unix
// (sticky 01777). Fall back to os.tmpdir() only on Windows.
// Override via AVANTI_WORLD_TMP for hardened systems where /tmp is mounted
// noexec (the worker exec fails with ENOEXEC in that case). The override path
// must be world-executable (all ancestor directories mode >=0711).
const WORLD_TMP_OVERRIDE = process.env.AVANTI_WORLD_TMP;
if (WORLD_TMP_OVERRIDE && process.platform !== 'win32') {
  validateWorldTmpOverride(WORLD_TMP_OVERRIDE);
}

// Validate the override: it must not be world-writable without the sticky bit
// (1000). Without sticky, any local user can rename/unlink files in the
// directory, enabling a race to replace the staged worker or IPC socket dir.
function validateWorldTmpOverride(dir: string): void {
  try {
    const st = fs.lstatSync(dir);
    const isWorldWritable = (st.mode & 0o002) !== 0;
    const hasSticky = (st.mode & 0o1000) !== 0;
    if (isWorldWritable && !hasSticky) {
      throw new Error(
        `AVANTI_WORLD_TMP=${dir} is world-writable without the sticky bit — ` +
          'any local user could race the temp directory. Set the sticky bit or use a private directory.',
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`AVANTI_WORLD_TMP=${dir} does not exist`, {
        cause: e,
      });
    }
    throw e;
  }
}

export const WORLD_TMP =
  WORLD_TMP_OVERRIDE ?? (process.platform === 'win32' ? os.tmpdir() : '/tmp');
