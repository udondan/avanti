import * as fs from 'fs';
import * as path from 'path';
import { createMinimalMeta, loadMetaForStaging } from './meta';
import { buildVersionList, parsePullLog, snapshotAtPull } from './pulls';
import {
  defaultBaseDir,
  normalizeDir,
  readJsonFile,
  sha256,
  uuid,
  writeJsonFile,
} from './storage';
import type {
  FileAtPull,
  FileHistory,
  FileHistoryMeta,
  InsertedFragment,
  PullLogEntry,
  PullLogFileRef,
  SourceShaRecord,
} from './types';

/** Optional settings of `HistoryManager.stageFileVersion`. */
interface StageFileVersionOptions {
  sources?: SourceShaRecord[];
  sudo?: true | string;
  v0Override?: Buffer;
  isSymlink?: boolean;
  v0IsSymlinkOverride?: boolean;
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
        writeJsonFile(metaPath, {
          configFile: this.configFile,
          workingDir: this.workingDir,
        });
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
    options: StageFileVersionOptions = {},
  ): { version: number; fileRef: PullLogFileRef } {
    const { sources, sudo, v0Override, isSymlink, v0IsSymlinkOverride } =
      options;
    const slug = sha256(targetPath);
    const fileDir = path.join(this.filesDir, slug);
    fs.mkdirSync(fileDir, { recursive: true });

    const metaPath = path.join(fileDir, 'meta.json');
    const { meta, isFirstSeen, isSymlinkChanged } = loadMetaForStaging(
      metaPath,
      {
        targetPath,
        fileDir,
        slug,
        isNew,
        isSymlink,
        v0Override,
        v0IsSymlinkOverride,
      },
    );

    const nextVersion = meta.currentVersion + 1;
    fs.writeFileSync(path.join(fileDir, `v${nextVersion}`), newContent);

    if (isFirstSeen) {
      writeJsonFile(metaPath, meta);
      const index = this.readIndex();
      index[targetPath] = slug;
      this.writeIndex(index);
    } else if (isSymlinkChanged) {
      writeJsonFile(metaPath, meta);
    }

    const fileRef: PullLogFileRef = {
      absolutePath: targetPath,
      slug,
      version: nextVersion,
      wasNew: isNew,
      ...(sudo ? { sudo } : {}),
      ...(sources !== undefined && { sources }),
      ...(isSymlink ? { isSymlink: true } : {}),
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
        const meta = readJsonFile<FileHistoryMeta>(metaPath);
        meta.currentVersion = ref.version;
        meta.sudo = ref.sudo || undefined;
        writeJsonFile(metaPath, meta);
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
      const entries = parsePullLog(fs.readFileSync(this.pullsLogPath, 'utf8'));
      entries.reverse();
      this.pullsCache = entries;
      return this.pullsCache;
    } catch {
      return [];
    }
  }

  getFileHistory(absolutePath: string): FileHistory | null {
    try {
      const meta = this.getFileMeta(absolutePath);
      if (!meta) return null;

      const pulls = this.chronologicalPulls();
      return {
        absolutePath,
        existedBeforeAvanti: meta.existedBeforeAvanti,
        currentVersion: meta.currentVersion,
        versions: buildVersionList(absolutePath, meta, pulls),
      };
    } catch {
      return null;
    }
  }

  readVersion(absolutePath: string, version: number): Buffer | null {
    try {
      const slug = this.readIndex()[absolutePath];
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
      const slug = this.readIndex()[absolutePath];
      if (!slug) return null;
      return this.readMeta(slug);
    } catch {
      return null;
    }
  }

  getFilesAtPull(pullId: string): Map<string, FileAtPull> {
    const result = new Map<string, FileAtPull>();
    const snapshot = snapshotAtPull(this.chronologicalPulls(), pullId);
    if (!snapshot) return result;

    for (const [absolutePath, { version, isSymlink }] of snapshot) {
      const meta = this.getFileMeta(absolutePath);
      result.set(absolutePath, {
        version,
        existedBeforeAvanti: meta?.existedBeforeAvanti ?? false,
        isSymlink,
      });
    }

    return result;
  }

  listTrackedFiles(): FileHistoryMeta[] {
    try {
      const metas: FileHistoryMeta[] = [];
      for (const slug of Object.values(this.readIndex())) {
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
        const meta = readJsonFile<{ configFile: string; workingDir: string }>(
          metaPath,
        );
        if (normalizeDir(meta.workingDir) === normalizeDir(workingDir)) {
          results.push(new HistoryManager(meta.configFile, meta.workingDir));
        }
      } catch {
        // skip corrupt meta
      }
    }
    return results;
  }

  getInsertedFragment(targetPath: string): InsertedFragment | null {
    const meta = this.getFileMeta(targetPath);
    return meta?.insertedFragment ?? null;
  }

  saveInsertedFragment(
    targetPath: string,
    raw: string,
    processed: string,
    owned?: unknown,
  ): void {
    const fragment: InsertedFragment =
      owned === undefined ? { raw, processed } : { raw, processed, owned };
    try {
      this.ensureStorageDir();
      const index = this.readIndex();
      const existingSlug = index[targetPath];
      // File wasn't staged (e.g. content was a no-op), create minimal entry.
      const slug = existingSlug || sha256(targetPath);
      const fileDir = path.join(this.filesDir, slug);
      const metaPath = path.join(fileDir, 'meta.json');
      const meta =
        existingSlug && fs.existsSync(metaPath)
          ? readJsonFile<FileHistoryMeta>(metaPath)
          : createMinimalMeta(fileDir, slug, targetPath);
      meta.insertedFragment = fragment;
      writeJsonFile(metaPath, meta);
      if (!existingSlug) {
        index[targetPath] = slug;
        this.writeIndex(index);
      }
    } catch {
      // non-fatal
    }
  }

  private chronologicalPulls(): PullLogEntry[] {
    return this.listPulls().slice().reverse();
  }

  private readIndex(): Record<string, string> {
    try {
      if (!fs.existsSync(this.indexPath)) return {};
      return readJsonFile<Record<string, string>>(this.indexPath);
    } catch {
      return {};
    }
  }

  private writeIndex(index: Record<string, string>): void {
    writeJsonFile(this.indexPath, index);
  }

  private readMeta(slug: string): FileHistoryMeta | null {
    try {
      const metaPath = path.join(this.filesDir, slug, 'meta.json');
      if (!fs.existsSync(metaPath)) return null;
      return readJsonFile<FileHistoryMeta>(metaPath);
    } catch {
      return null;
    }
  }
}
