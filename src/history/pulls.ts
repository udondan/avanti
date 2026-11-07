import type {
  FileHistoryMeta,
  FileVersionInfo,
  PullLogEntry,
  PullLogFileRef,
} from './types';

interface VersionPullInfo {
  pulledAt: string;
  pullId: string;
}

interface SnapshotEntry {
  version: number;
  isSymlink?: boolean;
}

/** Parses pulls.jsonl content, skipping corrupt lines. Returns oldest first. */
export function parsePullLog(content: string): PullLogEntry[] {
  const entries: PullLogEntry[] = [];
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      entries.push(JSON.parse(line) as PullLogEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return entries;
}

/**
 * Refs the pull wrote itself. Each entry also carries over the refs of files
 * it did not rewrite; those keep their version, so a ref with the same path
 * and version as in the previous entry was not written by this pull.
 */
export function writtenRefs(
  entry: PullLogEntry,
  previous: PullLogEntry | undefined,
): PullLogFileRef[] {
  if (!previous) return entry.files;
  const key = (r: PullLogFileRef): string => `${r.absolutePath}\0${r.version}`;
  const carried = new Set(previous.files.map(key));
  return entry.files.filter((r) => !carried.has(key(r)));
}

function buildVersionMap(
  chronologicalPulls: PullLogEntry[],
  absolutePath: string,
): Map<number, VersionPullInfo> {
  const versionMap = new Map<number, VersionPullInfo>();
  for (const [i, pull] of chronologicalPulls.entries()) {
    for (const ref of writtenRefs(pull, chronologicalPulls[i - 1])) {
      if (ref.absolutePath === absolutePath) {
        versionMap.set(ref.version, {
          pulledAt: pull.timestamp,
          pullId: pull.pullId,
        });
      }
    }
  }
  return versionMap;
}

/** Lists every version of a file with the pull that produced it. */
export function buildVersionList(
  absolutePath: string,
  meta: FileHistoryMeta,
  chronologicalPulls: PullLogEntry[],
): FileVersionInfo[] {
  const versionMap = buildVersionMap(chronologicalPulls, absolutePath);
  const versions: FileVersionInfo[] = [];
  if (meta.existedBeforeAvanti) {
    versions.push({
      version: 0,
      isOriginal: true,
      pulledAt: null,
      pullId: null,
    });
  }
  for (let v = 1; v <= meta.currentVersion; v++) {
    const info = versionMap.get(v);
    versions.push({
      version: v,
      isOriginal: false,
      pulledAt: info?.pulledAt ?? null,
      pullId: info?.pullId ?? null,
    });
  }
  return versions;
}

function recordRefs(
  snapshot: Map<string, SnapshotEntry>,
  refs: PullLogFileRef[],
): void {
  for (const ref of refs) {
    snapshot.set(ref.absolutePath, {
      version: ref.version,
      isSymlink: ref.isSymlink,
    });
  }
}

/**
 * Builds the state snapshot at `pullId`: for each file, the highest version at
 * or before the target pull. Returns null when the pull is unknown.
 */
export function snapshotAtPull(
  chronologicalPulls: PullLogEntry[],
  pullId: string,
): Map<string, SnapshotEntry> | null {
  // Track both version and isSymlink from the ref so revert uses per-version type info.
  const snapshot = new Map<string, SnapshotEntry>();
  for (const pull of chronologicalPulls) {
    // Always overwrite so we capture the most recent version before the target pull
    recordRefs(snapshot, pull.files);
    if (pull.pullId === pullId) return snapshot;
  }
  return null;
}
