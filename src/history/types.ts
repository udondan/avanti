export interface FileHistoryMeta {
  absolutePath: string;
  slug: string;
  firstSeenAt: string;
  existedBeforeAvanti: boolean;
  currentVersion: number;
  sudo?: true | string;
  isSymlink?: boolean;
  v0IsSymlink?: boolean;
  insertedFragment?: InsertedFragment;
}

export interface InsertedFragment {
  raw: string;
  processed: string;
  /** What the insert added to the file, for formats that track it (INI). */
  owned?: unknown;
}

export interface PullLogEntry {
  pullId: string;
  timestamp: string;
  configFile: string;
  files: PullLogFileRef[];
}

export interface SourceShaRecord {
  label: string;
  observedSha: string;
  expectedSha: string | undefined;
  accepted: boolean;
}

export interface PullLogFileRef {
  absolutePath: string;
  slug: string;
  version: number;
  wasNew: boolean;
  sudo?: true | string;
  sources?: SourceShaRecord[];
  isSymlink?: boolean;
}

export interface FileVersionInfo {
  version: number;
  isOriginal: boolean;
  pulledAt: string | null;
  pullId: string | null;
}

export interface FileHistory {
  absolutePath: string;
  existedBeforeAvanti: boolean;
  currentVersion: number;
  versions: FileVersionInfo[];
}

export interface FileAtPull {
  version: number;
  existedBeforeAvanti: boolean;
  isSymlink?: boolean;
}
