import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { computeContentSha256 } from './sha';

export interface FileHistoryMeta {
  absolutePath: string;
  slug: string;
  firstSeenAt: string;
  existedBeforeAvanti: boolean;
  currentVersion: number;
  sudo?: true | string;
  insertedFragment?: {
    raw: string;
    processed: string;
  };
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

function defaultBaseDir(): string {
  return (
    process.env.AVANTI_HISTORY_DIR ??
    path.join(os.homedir(), '.config', 'avanti')
  );
}

function normalizeDir(p: string): string {
  const norm = path.normalize(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function sha256(input: string): string {
  return computeContentSha256(input);
}

function uuid(): string {
  return crypto.randomUUID();
}

export class HistoryManager {
  private readonly baseDir: string;
  private readonly projectSlug: string;
  private readonly projectDir: string;
  private readonly filesDir: string;
  private readonly indexPath: string;
  private readonly pullsLogPath: string;
  private readonly configFile: string;
  private readonly workingDir: string;
  private pullsCache: PullLogEntry[] | null = null;

  constructor(configFile: string, workingDir: string) {
    this.configFile = configFile;
    this.workingDir = workingDir;
    this.baseDir = defaultBaseDir();
    this.projectSlug = sha256(`${configFile}|${workingDir}`);
    this.projectDir = path.join(this.baseDir, 'projects', this.projectSlug);
    this.filesDir = path.join(this.projectDir, 'files');
    this.indexPath = path.join(this.filesDir, 'index.json');
    this.pullsLogPath = path.join(this.projectDir, 'pulls.jsonl');
  }

  ensureStorageDir(): boolean {
    try {
      fs.mkdirSync(this.filesDir, { recursive: true });
      const metaPath = path.join(this.projectDir, 'meta.json');
      if (!fs.existsSync(metaPath)) {
        fs.writeFileSync(
          metaPath,
          JSON.stringify(
            { configFile: this.configFile, workingDir: this.workingDir },
            null,
            2,
          ),
          'utf8',
        );
      }
      return true;
    } catch (err) {
      console.warn(
        `Warning: could not initialise history storage at ${this.baseDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  openPullSession(): string {
    return uuid();
  }

  stageFileVersion(
    pullId: string,
    targetPath: string,
    newContent: Buffer,
    isNew: boolean,
    sources?: SourceShaRecord[],
    sudo?: true | string,
  ): { version: number; fileRef: PullLogFileRef } {
    const slug = sha256(targetPath);
    const fileDir = path.join(this.filesDir, slug);
    fs.mkdirSync(fileDir, { recursive: true });

    const metaPath = path.join(fileDir, 'meta.json');
    let meta: FileHistoryMeta;

    let isFirstSeen = false;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as FileHistoryMeta;
    } else {
      isFirstSeen = true;
      const existedBeforeAvanti = !isNew && fs.existsSync(targetPath);
      if (existedBeforeAvanti) {
        try {
          const originalContent = fs.readFileSync(targetPath);
          fs.writeFileSync(path.join(fileDir, 'v0'), originalContent);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EACCES' && code !== 'EPERM') {
            throw err;
          }
          // File exists but is unreadable (e.g. root-owned 0600).
          // Record that it existed without capturing v0 — stale cleanup
          // still works; revert-to-original is unavailable for this file.
        }
      }
      meta = {
        absolutePath: targetPath,
        slug,
        firstSeenAt: new Date().toISOString(),
        existedBeforeAvanti,
        currentVersion: 0,
      };
    }

    const nextVersion = meta.currentVersion + 1;
    fs.writeFileSync(path.join(fileDir, `v${nextVersion}`), newContent);

    if (isFirstSeen) {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      const index = this.readIndex();
      index[targetPath] = slug;
      this.writeIndex(index);
    }

    const fileRef: PullLogFileRef = {
      absolutePath: targetPath,
      slug,
      version: nextVersion,
      wasNew: isNew,
      ...(sudo ? { sudo } : {}),
      ...(sources !== undefined && { sources }),
    };

    return { version: nextVersion, fileRef };
  }

  closePullSession(
    pullId: string,
    configFile: string,
    fileRefs: PullLogFileRef[],
  ): void {
    for (const ref of fileRefs) {
      const metaPath = path.join(this.filesDir, ref.slug, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(
          fs.readFileSync(metaPath, 'utf8'),
        ) as FileHistoryMeta;
        meta.currentVersion = ref.version;
        meta.sudo = ref.sudo || undefined;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      }
    }

    const entry: PullLogEntry = {
      pullId,
      timestamp: new Date().toISOString(),
      configFile,
      files: fileRefs,
    };
    fs.appendFileSync(this.pullsLogPath, JSON.stringify(entry) + '\n', 'utf8');
    this.pullsCache = null;
  }

  listPulls(): PullLogEntry[] {
    if (this.pullsCache !== null) return this.pullsCache;
    try {
      if (!fs.existsSync(this.pullsLogPath)) return [];
      const lines = fs
        .readFileSync(this.pullsLogPath, 'utf8')
        .split('\n')
        .filter(Boolean);
      const entries: PullLogEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as PullLogEntry);
        } catch {
          // skip corrupt lines
        }
      }
      this.pullsCache = entries.reverse();
      return this.pullsCache;
    } catch {
      return [];
    }
  }

  getFileHistory(absolutePath: string): FileHistory | null {
    try {
      const index = this.readIndex();
      const slug = index[absolutePath];
      if (!slug) return null;

      const meta = this.readMeta(slug);
      if (!meta) return null;

      const pulls = this.listPulls().slice().reverse(); // chronological order for version lookup
      const versionMap = new Map<
        number,
        { pulledAt: string; pullId: string }
      >();
      for (const pull of pulls) {
        for (const ref of pull.files) {
          if (ref.absolutePath === absolutePath) {
            versionMap.set(ref.version, {
              pulledAt: pull.timestamp,
              pullId: pull.pullId,
            });
          }
        }
      }

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

      return {
        absolutePath,
        existedBeforeAvanti: meta.existedBeforeAvanti,
        currentVersion: meta.currentVersion,
        versions,
      };
    } catch {
      return null;
    }
  }

  readVersion(absolutePath: string, version: number): Buffer | null {
    try {
      const index = this.readIndex();
      const slug = index[absolutePath];
      if (!slug) return null;
      const versionPath = path.join(this.filesDir, slug, `v${version}`);
      if (!fs.existsSync(versionPath)) return null;
      return fs.readFileSync(versionPath);
    } catch {
      return null;
    }
  }

  getFileMeta(absolutePath: string): FileHistoryMeta | null {
    try {
      const index = this.readIndex();
      const slug = index[absolutePath];
      if (!slug) return null;
      return this.readMeta(slug);
    } catch {
      return null;
    }
  }

  updateFileSudo(absolutePath: string, sudo: true | string | undefined): void {
    try {
      const index = this.readIndex();
      const slug = index[absolutePath];
      if (!slug) return;
      const metaPath = path.join(this.filesDir, slug, 'meta.json');
      if (!fs.existsSync(metaPath)) return;
      const meta = JSON.parse(
        fs.readFileSync(metaPath, 'utf8'),
      ) as FileHistoryMeta;
      meta.sudo = sudo || undefined;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  }

  getFilesAtPull(
    pullId: string,
  ): Map<string, { version: number; existedBeforeAvanti: boolean }> {
    const result = new Map<
      string,
      { version: number; existedBeforeAvanti: boolean }
    >();
    const pulls = this.listPulls().slice().reverse(); // chronological

    // Build state snapshot: for each file, find highest version at or before the target pull
    let found = false;
    const snapshot = new Map<string, number>(); // absolutePath → version at target pull

    for (const pull of pulls) {
      if (pull.pullId === pullId) {
        for (const ref of pull.files) {
          snapshot.set(ref.absolutePath, ref.version);
        }
        found = true;
        break;
      }
      // Always overwrite so we capture the most recent version before the target pull
      for (const ref of pull.files) {
        snapshot.set(ref.absolutePath, ref.version);
      }
    }

    if (!found) return result;

    for (const [absolutePath, version] of snapshot) {
      const meta = this.getFileMeta(absolutePath);
      result.set(absolutePath, {
        version,
        existedBeforeAvanti: meta?.existedBeforeAvanti ?? false,
      });
    }

    return result;
  }

  listTrackedFiles(): FileHistoryMeta[] {
    try {
      const index = this.readIndex();
      const metas: FileHistoryMeta[] = [];
      for (const slug of Object.values(index)) {
        const meta = this.readMeta(slug);
        if (meta) metas.push(meta);
      }
      return metas;
    } catch {
      return [];
    }
  }

  getLastPullFiles(): PullLogFileRef[] {
    const pulls = this.listPulls();
    if (pulls.length === 0) return [];
    return pulls[0].files; // listPulls returns newest first
  }

  hasHistory(): boolean {
    return fs.existsSync(this.pullsLogPath);
  }

  static findByWorkingDir(workingDir: string): HistoryManager[] {
    const projectsDir = path.join(defaultBaseDir(), 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    let slugs: string[];
    try {
      slugs = fs.readdirSync(projectsDir);
    } catch {
      return [];
    }

    const results: HistoryManager[] = [];
    for (const slug of slugs) {
      const metaPath = path.join(projectsDir, slug, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          configFile: string;
          workingDir: string;
        };
        if (normalizeDir(meta.workingDir) === normalizeDir(workingDir)) {
          results.push(new HistoryManager(meta.configFile, meta.workingDir));
        }
      } catch {
        // skip corrupt meta
      }
    }
    return results;
  }

  getInsertedFragment(
    targetPath: string,
  ): { raw: string; processed: string } | null {
    const meta = this.getFileMeta(targetPath);
    return meta?.insertedFragment ?? null;
  }

  saveInsertedFragment(
    targetPath: string,
    raw: string,
    processed: string,
  ): void {
    try {
      this.ensureStorageDir();
      const index = this.readIndex();
      let slug = index[targetPath];

      if (!slug) {
        // File wasn't staged (e.g. content was a no-op), create minimal entry.
        slug = sha256(targetPath);
        const fileDir = path.join(this.filesDir, slug);
        fs.mkdirSync(fileDir, { recursive: true });
        const existedBeforeAvanti = fs.existsSync(targetPath);
        if (existedBeforeAvanti) {
          fs.writeFileSync(
            path.join(fileDir, 'v0'),
            fs.readFileSync(targetPath),
          );
        }
        const meta: FileHistoryMeta = {
          absolutePath: targetPath,
          slug,
          firstSeenAt: new Date().toISOString(),
          existedBeforeAvanti,
          currentVersion: 0,
          insertedFragment: { raw, processed },
        };
        fs.writeFileSync(
          path.join(fileDir, 'meta.json'),
          JSON.stringify(meta, null, 2),
          'utf8',
        );
        index[targetPath] = slug;
        this.writeIndex(index);
        return;
      }

      const metaPath = path.join(this.filesDir, slug, 'meta.json');
      let meta: FileHistoryMeta;
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as FileHistoryMeta;
      } else {
        const fileDir = path.join(this.filesDir, slug);
        fs.mkdirSync(fileDir, { recursive: true });
        const existedBeforeAvanti = fs.existsSync(targetPath);
        if (existedBeforeAvanti) {
          fs.writeFileSync(
            path.join(fileDir, 'v0'),
            fs.readFileSync(targetPath),
          );
        }
        meta = {
          absolutePath: targetPath,
          slug,
          firstSeenAt: new Date().toISOString(),
          existedBeforeAvanti,
          currentVersion: 0,
        };
      }
      meta.insertedFragment = { raw, processed };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  }

  private readIndex(): Record<string, string> {
    try {
      if (!fs.existsSync(this.indexPath)) return {};
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }

  private writeIndex(index: Record<string, string>): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  private readMeta(slug: string): FileHistoryMeta | null {
    try {
      const metaPath = path.join(this.filesDir, slug, 'meta.json');
      if (!fs.existsSync(metaPath)) return null;
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as FileHistoryMeta;
    } catch {
      return null;
    }
  }
}
