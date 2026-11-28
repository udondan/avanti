/** Pre-flight checks that destination ancestors cannot be raced by other users. */
import * as fs from 'fs';
import * as path from 'path';

interface DirStat {
  mode?: number;
  ownerUid?: number;
}

const TOCTOU_SUFFIX = 'cannot safely create a temp file here (TOCTOU risk).';

// Verifies that a directory is safe to use as a mktemp staging location.
// Rejects directories that are group- or world-writable (mode & 0o022) WITHOUT
// the sticky bit — any member of the group or any local user could rename the
// just-created temp path to a symlink before the subsequent tee/cp opens it,
// redirecting the privileged write. Directories with the sticky bit set (e.g.
// /tmp on Linux) are safe: the sticky bit prevents users from renaming entries
// they do not own, neutralising the rename-to-symlink attack.
// When trustedUids is provided, also rejects directories whose owner UID is not
// in that set — the owner can always rename entries regardless of the sticky bit.
function checkDirSafe(
  absDir: string,
  trustedUids: Set<number> | undefined,
  label: string,
): void {
  const st = statDirForSafety(absDir, trustedUids, label);
  if (st === undefined) return;

  // A directory is unsafe when it is group- or world-writable AND does NOT have
  // the sticky bit set. With the sticky bit (e.g. /tmp on Linux, mode 01777),
  // only the file owner can rename or remove entries, so the rename-to-symlink
  // attack is neutralised.
  // Skip on Windows: NTFS ACLs do not map to Unix mode bits — fs.statSync
  // returns synthetic values that may falsely flag drives as world-writable.
  // The rename-to-symlink TOCTOU attack requires Unix filesystem semantics.
  if (process.platform !== 'win32') {
    assertNotWritableWithoutSticky(st.mode, absDir, label);
  }
  if (trustedUids !== undefined) {
    // Fail closed: if the owner UID is unknown (stat fallback also failed),
    // we cannot verify safety — reject rather than skip the check.
    if (st.ownerUid === undefined) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} owner UID could not be determined; ` +
          TOCTOU_SUFFIX,
      );
    }
    if (!trustedUids.has(st.ownerUid)) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} is owned by UID ${st.ownerUid}, ` +
          `not a trusted identity; ${TOCTOU_SUFFIX}`,
      );
    }
  }
}

function assertNotWritableWithoutSticky(
  mode: number | undefined,
  absDir: string,
  label: string,
): void {
  const knownMode = mode !== undefined && !isNaN(mode);
  const isWritable = knownMode && !!(mode & 0o022);
  const hasSticky = knownMode && !!(mode & 0o1000);
  if (isWritable && !hasSticky) {
    throw new Error(
      `sudo write: ${label} directory ${absDir} is group- or world-writable; ` +
        TOCTOU_SUFFIX,
    );
  }
}

// Returns the mode and owner to validate, or undefined when the check must be
// skipped for absDir.
function statDirForSafety(
  absDir: string,
  trustedUids: Set<number> | undefined,
  label: string,
): DirStat | undefined {
  // Prefer unprivileged stat — ancestor directories like /usr/local/bin are
  // world-readable and do not require sudo. Avoiding sudo here prevents
  // repeated password prompts when sudo credential caching is unavailable
  // (e.g. timestamp_timeout=0 or when all stdio fds are non-TTY so macOS
  // sudo cannot locate the cached credential).
  //
  // Use lstatSync so that symlink ancestors are visible. When a path component
  // is a symlink inside a sticky world-writable directory (e.g. /tmp/link/),
  // the sticky bit only prevents *other* users from renaming the symlink — the
  // symlink's own owner can still rename it, redirecting privileged writes.
  // Checking the symlink's UID (not its target's UID) catches this case.
  try {
    const lst = fs.lstatSync(absDir);
    if (lst.isSymbolicLink()) {
      return statSymlinkDir(absDir, lst.uid, trustedUids, label);
    }
    return { mode: lst.mode & 0o7777, ownerUid: lst.uid };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined; // directory does not exist yet; mkdir -p will create it
    // An unreadable (EACCES/EPERM) ancestor: we cannot lstat it without an
    // extra sudo call, which would add a password prompt for every unreadable
    // ancestor before the worker prompt and break the single-prompt guarantee
    // on machines with timestamp_timeout=0. Skip here; the privileged worker's
    // checkAncestorsSafeAsRoot (runs as root, no EACCES constraint) re-validates
    // ALL ancestors at write time before touching any file.
    //
    // Accepted residual race: an attacker who owns the EACCES ancestor (trusted
    // UID) could make it world-writable, plant a malicious rename target inside,
    // then remove the world-writable bit — all in the window between this skip
    // and the worker's re-check. The worker's check catches the world-writable
    // bit only if it is still set when the check runs. Exploiting this requires
    // owning a trusted-UID ancestor AND winning a sub-millisecond timing race
    // against both the parent and the worker; accepted as a residual risk.
    if (code === 'EACCES' || code === 'EPERM') return undefined;
    throw e;
  }
}

// For symlinks: the owner can rename the link regardless of the parent's
// sticky bit. Use the symlink's UID (ownerUid) for the ownership check.
function statSymlinkDir(
  absDir: string,
  ownerUid: number,
  trustedUids: Set<number> | undefined,
  label: string,
): DirStat | undefined {
  let mode: number | undefined;
  // Also capture the target directory's owner: mktemp/tee/mv operate
  // inside the resolved target, so its owner can rename root-created temp
  // entries regardless of the symlink's owner.
  let targetOwnerUid: number | undefined;
  // Follow the link to get the target directory's mode for the writable check.
  try {
    const s = fs.statSync(absDir);
    mode = s.mode & 0o7777;
    targetOwnerUid = s.uid;
  } catch (e2) {
    const code2 = (e2 as NodeJS.ErrnoException).code;
    if (code2 === 'EACCES' || code2 === 'EPERM') {
      // Symlink target is unreadable without root. We cannot check the target
      // directory's mode or owner, but we CAN (and must) validate the symlink
      // owner before returning. An untrusted UID owns the symlink and can
      // atomically swap it between our preflight and the worker's write,
      // redirecting privileged writes. ownerUid was already captured from
      // lstatSync above — validate it now before returning early.
      if (trustedUids !== undefined && !trustedUids.has(ownerUid)) {
        throw new Error(
          `sudo write: ${label} directory ${absDir} symlink is owned by UID ${ownerUid}, ` +
            `not a trusted identity; ${TOCTOU_SUFFIX}`,
          { cause: e2 },
        );
      }
      return undefined;
    }
    // Dangling symlink (ENOENT) — target is gone, but ownerUid is already
    // captured. Do NOT return: fall through so the symlink owner is still
    // validated below. Without this check, an attacker can race between
    // mkdir -p (symlink pointing at a real dir) and mktemp/mv (dangling) to
    // bypass the trusted-UID guard entirely.
    if (code2 !== 'ENOENT') throw e2;
  }
  // Validate the target directory's owner separately from the symlink owner.
  // Fail closed: if the target UID is unknown (dangling symlink or stat
  // failure), we cannot verify safety — reject rather than skip the check.
  if (trustedUids !== undefined) {
    if (targetOwnerUid === undefined) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} symlink target owner UID could not be determined; ` +
          TOCTOU_SUFFIX,
      );
    }
    if (!trustedUids.has(targetOwnerUid)) {
      throw new Error(
        `sudo write: ${label} directory ${absDir} symlink target is owned by UID ${targetOwnerUid}, ` +
          `not a trusted identity; ${TOCTOU_SUFFIX}`,
      );
    }
  }
  return { mode, ownerUid };
}

// Collects ancestor directories of targetPath from filesystem root down to the
// immediate parent, then calls callback for each. Mirrors the equivalent helper
// in privileged-worker.ts; both must use the same root-detection idiom
// (`anc === path.dirname(anc)`) so that any edge-case fixes stay consistent.
function walkAncestors(
  targetPath: string,
  callback: (anc: string) => void,
): void {
  const ancestors: string[] = [];
  let anc = path.resolve(targetPath);
  while (true) {
    anc = path.dirname(anc);
    ancestors.unshift(anc);
    if (anc === path.dirname(anc)) break; // reached filesystem root
  }
  for (const ancestor of ancestors) {
    callback(ancestor);
  }
}

// Walks every ancestor of targetPath (from the filesystem root down to its
// parent directory) and calls checkDirSafe on each. A single writable or
// untrusted-owned ancestor anywhere in the path is sufficient for a race:
// an attacker can swap that component to a symlink between the sudo preflight
// checks and the sudo mktemp/tee/mv, redirecting the privileged write.
//
// EACCES on an ancestor causes a silent pass here (see checkDirSafe for
// rationale). The worker's checkAncestorsSafeAsRoot is the authoritative check
// and re-validates every ancestor as root before touching any file.
export function checkAncestorsSafe(
  targetPath: string,
  trustedUids: Set<number> | undefined,
  label: string,
  checkedDirs?: Set<string>,
): void {
  walkAncestors(targetPath, (ancestor) => {
    if (checkedDirs?.has(ancestor)) return;
    checkDirSafe(ancestor, trustedUids, `${label} ancestor`);
    checkedDirs?.add(ancestor);
  });
}
