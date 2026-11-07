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

function buildVersionMap(
  chronologicalPulls: PullLogEntry[],
  absolutePath: string,
): Map<number, VersionPullInfo> {
  const versionMap = new Map<number, VersionPullInfo>();
  for (const pull of chronologicalPulls) {
    for (const ref of pull.files) {
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
