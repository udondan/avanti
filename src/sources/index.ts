import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { isVerbose, verbose } from '../logger';
import { redactUrl } from '../fetch';
import {
  FileEntry,
  FileSrc,
  JsonMergeOptions,
  YamlMergeOptions,
  TomlMergeOptions,
  IniMergeOptions,
  Variables,
} from '../types';
import { evaluateConditions } from '../condition';
import { resolveTargetPath } from '../paths';
import { resolveVars, resolveVarsShellSafe } from '../variables';
import { fetchHttp, inferFilenameFromUrl } from './http';
import { fetchLocal } from './local';
import { fetchExec } from './exec';
import { fetchGitLab, fetchGitLabRelease } from './gitlab';
import { fetchGitHub, fetchGitHubRelease } from './github';
import { fetchBitbucket } from './bitbucket';
import { fetchGit, isGitRemoteUrl, parseGitRemoteSpec } from './git';
import { fetchS3 } from './s3';
import { fetchSecretsManager } from './secrets-manager';
import { fetchSsm } from './ssm';
import { fetchVault } from './vault';
import { mergeJson, formatJson } from '../processors/json';
import { mergeYaml, formatYaml } from '../processors/yaml';
import { mergeToml, formatToml } from '../processors/toml';
import { mergeIni, formatIni } from '../processors/ini';
import { isBinary } from '../binary';
import { applyFilter } from '../filter';
import { extractArchive, detectArchiveFormat } from '../extract';
import {
  parseGitHubSpec,
  parseGitLabSpec,
  resolveRelativeSrc,
} from '../config';

const JSON_EXTENSIONS = new Set(['.json', '.jsonc']);
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const TOML_EXTENSIONS = new Set(['.toml']);
const INI_EXTENSIONS = new Set(['.ini', '.cfg']);

function srcFilename(src: FileSrc): string | null {
  if (typeof src === 'string') {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      try {
        return new URL(src).pathname;
      } catch {
        return src;
      }
    }
    if (isGitRemoteUrl(src)) {
      try {
        return parseGitRemoteSpec(src).file;
      } catch {
        return src;
      }
    }
    return src;
  }
  if ('gitlab' in src) return 'file' in src.gitlab ? src.gitlab.file : null;
  if ('github' in src) return 'file' in src.github ? src.github.file : null;
  if ('bitbucket' in src) return src.bitbucket.file;
  if ('git' in src) return src.git.file;
  if ('aws_s3' in src) return src.aws_s3;
  if ('aws_secrets_manager' in src)
    return (
      src.aws_secrets_manager.name.split(/[:/]/).filter(Boolean).pop() ?? null
    );
  if ('aws_systems_manager_parameter' in src)
    return src.aws_systems_manager_parameter.name;
  if ('http' in src) {
    try {
      return new URL(src.http).pathname;
    } catch {
      return src.http; // variable-driven URL; pathname unavailable at parse time
    }
  }
  if ('path' in src) return src.path;
  if ('url' in src) {
    if (isGitRemoteUrl(src.url)) {
      try {
        return parseGitRemoteSpec(src.url).file;
      } catch {
        return src.url;
      }
    }
    try {
      return new URL(src.url).pathname;
    } catch {
      return src.url;
    }
  }
  return null;
}

function hasJsonExtension(src: FileSrc): boolean {
  const name = srcFilename(src);
  if (!name) return false;
  return JSON_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function hasYamlExtension(src: FileSrc): boolean {
  const name = srcFilename(src);
  if (!name) return false;
  return YAML_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function hasTomlExtension(src: FileSrc): boolean {
  const name = srcFilename(src);
  if (!name) return false;
  return TOML_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function hasIniExtension(src: FileSrc): boolean {
  const name = srcFilename(src);
  if (!name) return false;
  return INI_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function resolveJsonOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): JsonMergeOptions | null {
  const { json } = entry;
  if (json === false) return null;
  if (json === true) return {};
  if (json !== undefined && typeof json === 'object') return json;
  // Auto-detect: all sources have a JSON/JSONC file extension
  if (srcs.length > 0 && srcs.every(hasJsonExtension)) return {};
  return null;
}

export function resolveYamlOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): YamlMergeOptions | null {
  const { yaml } = entry;
  if (yaml === false) return null;
  if (yaml === true) return {};
  if (yaml !== undefined && typeof yaml === 'object') return yaml;
  // Auto-detect: all sources have a YAML file extension
  if (srcs.length > 0 && srcs.every(hasYamlExtension)) return {};
  return null;
}

export function resolveTomlOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): TomlMergeOptions | null {
  const { toml } = entry;
  if (toml === false) return null;
  if (toml === true) return {};
  if (toml !== undefined && typeof toml === 'object') return toml;
  // Auto-detect: all sources have a TOML file extension
  if (srcs.length > 0 && srcs.every(hasTomlExtension)) return {};
  return null;
}

export function resolveIniOptions(
  entry: FileEntry,
  srcs: FileSrc[],
): IniMergeOptions | null {
  const { ini } = entry;
  if (ini === false) return null;
  if (ini === true) return {};
  if (ini !== undefined && typeof ini === 'object') return ini;
  // Auto-detect: all sources have an INI file extension
  if (srcs.length > 0 && srcs.every(hasIniExtension)) return {};
  return null;
}

export interface SourceFetchRecord {
  sourceLabel: string;
  observedSha: string;
  expectedSha: string | undefined;
  matched: boolean;
}

export interface FetchResult {
  files: Map<string, Buffer>;
  sourceRecords: SourceFetchRecord[];
  allSkipped?: boolean;
}

export type FetchCache = Map<string, { files: Map<string, Buffer> }>;

// labelForSrc returns the source label used in SourceFetchRecord. Structured
// sources (github:, gitlab:, etc.) keep variable references unresolved so the
// label matches the literal YAML values that applyUpdatedShas reads for SHA
// writeback. Plain-string sources resolve variables since they don't support
// SHA pinning. When a filter is present a NUL-byte separator (\x00) is used
// before "filter:<json>" so the label is unambiguous even if the base contains
// the display string " | filter:" (e.g. a local path with that literal text).
// Use formatSourceLabel() to convert to a human-readable form for display.
function labelForSrc(src: FileSrc, vars: Variables): string {
  const base = baseLabelForSrc(src, vars);
  const filter = filterForSrc(src);
  if (filter && filter.length > 0)
    return `${base}\x00filter:${JSON.stringify(filter)}`;
  return base;
}

// formatSourceLabel converts an internal label (which may contain a NUL-byte
// filter separator) into a human-readable string for log/error output.
export function formatSourceLabel(label: string): string {
  return label.replace('\x00filter:', ' | filter:');
}

function baseLabelForSrc(src: FileSrc, vars: Variables): string {
  if (typeof src === 'string') return resolveVars(src, vars);
  if ('github' in src) {
    const host = src.github.host ? `[${src.github.host}]` : '';
    if ('release' in src.github) {
      return `github${host}:${src.github.repo}:release:${src.github.release}`;
    }
    const ref = src.github.ref ? `@${src.github.ref}` : '';
    return `github${host}:${src.github.repo}:${src.github.file}${ref}`;
  }
  if ('gitlab' in src) {
    const host = src.gitlab.host ? `[${src.gitlab.host}]` : '';
    if ('release' in src.gitlab) {
      return `gitlab${host}:${src.gitlab.project}:release:${src.gitlab.release}`;
    }
    const ref = src.gitlab.ref ? `@${src.gitlab.ref}` : '';
    return `gitlab${host}:${src.gitlab.project}:${src.gitlab.file}${ref}`;
  }
  if ('bitbucket' in src) {
    const ref = src.bitbucket.ref ? `@${src.bitbucket.ref}` : '';
    const host = src.bitbucket.host ? `[${src.bitbucket.host}]` : '';
    return `bitbucket${host}:${src.bitbucket.workspace}/${src.bitbucket.repo}:${src.bitbucket.file}${ref}`;
  }
  if ('git' in src) {
    const ref = src.git.ref ? `@${src.git.ref}` : '';
    return `git:${src.git.repo}:${src.git.file}${ref}`;
  }
  if ('exec' in src) return `exec:${src.exec}`;
  if ('aws_s3' in src) return `aws_s3:${src.aws_s3}`;
  if ('aws_secrets_manager' in src) {
    const k =
      src.aws_secrets_manager.key !== undefined
        ? `#${src.aws_secrets_manager.key}`
        : '';
    const r =
      src.aws_secrets_manager.region !== undefined
        ? `@${src.aws_secrets_manager.region}`
        : '';
    return `aws_secrets_manager:${src.aws_secrets_manager.name}${k}${r}`;
  }
  if ('aws_systems_manager_parameter' in src) {
    const r =
      src.aws_systems_manager_parameter.region !== undefined
        ? `@${src.aws_systems_manager_parameter.region}`
        : '';
    return `aws_systems_manager_parameter:${src.aws_systems_manager_parameter.name}${r}`;
  }
  if ('vault' in src) {
    const field = src.vault.field ? `#${src.vault.field}` : '';
    return `vault:${src.vault.path}${field}`;
  }
  if ('http' in src) return `http:${src.http}`;
  if ('path' in src) return `path:${src.path}`;
  if ('url' in src) return `url:${src.url}`;
  if ('raw' in src) return 'raw';
  return JSON.stringify(src);
}

// cacheKeyForSrc returns a fully-resolved key for FetchCache so that sources
// using variables are correctly distinguished when vars change between
// stabilization iterations, and raw: sources are keyed by their content.
function cacheKeyForSrc(src: FileSrc, vars: Variables): string {
  let base: string;
  if (typeof src === 'string') return resolveVars(src, vars);
  if ('github' in src) {
    const resolvedHost = src.github.host
      ? resolveVars(src.github.host, vars).trim()
      : '';
    const host = resolvedHost ? `[${resolvedHost}]` : '';
    const viaStr = Array.isArray(src.github.via)
      ? src.github.via.join(',')
      : (src.github.via ?? 'api,cli');
    const via = viaStr === 'api,cli' ? '' : `(${viaStr})`;
    if ('release' in src.github) {
      base = `github${host}:${resolveVars(src.github.repo, vars)}:release:${resolveVars(src.github.release, vars)}${via}`;
    } else {
      const ref = src.github.ref ? `@${resolveVars(src.github.ref, vars)}` : '';
      base = `github${host}:${resolveVars(src.github.repo, vars)}:${resolveVars(src.github.file, vars)}${ref}${via}`;
    }
  } else if ('gitlab' in src) {
    const resolvedHost = src.gitlab.host
      ? resolveVars(src.gitlab.host, vars).trim()
      : '';
    const host = resolvedHost ? `[${resolvedHost}]` : '';
    const viaStr = Array.isArray(src.gitlab.via)
      ? src.gitlab.via.join(',')
      : (src.gitlab.via ?? 'api,cli');
    const via = viaStr === 'api,cli' ? '' : `(${viaStr})`;
    if ('release' in src.gitlab) {
      base = `gitlab${host}:${resolveVars(src.gitlab.project, vars)}:release:${resolveVars(src.gitlab.release, vars)}${via}`;
    } else {
      const ref = src.gitlab.ref ? `@${resolveVars(src.gitlab.ref, vars)}` : '';
      base = `gitlab${host}:${resolveVars(src.gitlab.project, vars)}:${resolveVars(src.gitlab.file, vars)}${ref}${via}`;
    }
  } else if ('bitbucket' in src) {
    const ref = src.bitbucket.ref
      ? `@${resolveVars(src.bitbucket.ref, vars)}`
      : '';
    const resolvedHost = src.bitbucket.host
      ? resolveVars(src.bitbucket.host, vars).trim()
      : '';
    const host = resolvedHost ? `[${resolvedHost}]` : '';
    base = `bitbucket${host}:${resolveVars(src.bitbucket.workspace, vars)}/${resolveVars(src.bitbucket.repo, vars)}:${resolveVars(src.bitbucket.file, vars)}${ref}`;
  } else if ('git' in src) {
    const ref = src.git.ref ? `@${resolveVars(src.git.ref, vars)}` : '';
    base = `git:${resolveVars(src.git.repo, vars)}:${resolveVars(src.git.file, vars)}${ref}`;
  } else if ('exec' in src) {
    return `exec:${resolveVars(src.exec, vars)}`;
  } else if ('aws_s3' in src) {
    base = `aws_s3:${resolveVars(src.aws_s3, vars)}`;
  } else if ('aws_secrets_manager' in src) {
    const k =
      src.aws_secrets_manager.key !== undefined
        ? `#${resolveVars(src.aws_secrets_manager.key, vars)}`
        : '';
    const r =
      src.aws_secrets_manager.region !== undefined
        ? `@${resolveVars(src.aws_secrets_manager.region, vars)}`
        : '';
    return `aws_secrets_manager:${resolveVars(src.aws_secrets_manager.name, vars)}${k}${r}`;
  } else if ('aws_systems_manager_parameter' in src) {
    const r =
      src.aws_systems_manager_parameter.region !== undefined
        ? `@${resolveVars(src.aws_systems_manager_parameter.region, vars)}`
        : '';
    return `aws_systems_manager_parameter:${resolveVars(src.aws_systems_manager_parameter.name, vars)}${r}`;
  } else if ('vault' in src) {
    const field = src.vault.field
      ? `#${resolveVars(src.vault.field, vars)}`
      : '';
    return `vault:${resolveVars(src.vault.path, vars)}${field}`;
  } else if ('http' in src) {
    return `http:${resolveVars(src.http, vars)}`;
  } else if ('path' in src) {
    base = `path:${resolveVars(src.path, vars)}`;
  } else if ('url' in src) {
    return `url:${resolveVars(src.url, vars)}`;
  } else if ('raw' in src) {
    // raw: key includes the resolved content so distinct raw values don't collide
    return `raw:${resolveVars(src.raw, vars)}`;
  } else {
    return JSON.stringify(src);
  }
  return base;
}

function expectedShaForSrc(src: FileSrc): string | undefined {
  if (typeof src === 'string') return undefined;
  if ('github' in src) return src.github.sha;
  if ('gitlab' in src) return src.gitlab.sha;
  if ('bitbucket' in src) return src.bitbucket.sha;
  if ('git' in src) return src.git.sha;
  if ('exec' in src) return src.sha;
  if ('aws_s3' in src) return src.sha;
  if ('aws_secrets_manager' in src) return src.aws_secrets_manager.sha;
  if ('aws_systems_manager_parameter' in src)
    return src.aws_systems_manager_parameter.sha;
  if ('vault' in src) return src.vault.sha;
  if ('http' in src) return src.sha;
  if ('path' in src) return src.sha;
  if ('url' in src) return src.sha;
  return undefined;
}

function shaSupported(src: FileSrc): boolean {
  if (typeof src === 'string') return false; // local paths excluded; plain string HTTP has no sha field
  if ('raw' in src) return false;
  return true;
}

function buildRecord(
  src: FileSrc,
  files: Map<string, Buffer>,
  vars: Variables,
): SourceFetchRecord | null {
  if (!shaSupported(src)) return null;
  const observedSha = computeFilesSha(files);
  const expectedSha = expectedShaForSrc(src);
  return {
    sourceLabel: labelForSrc(src, vars),
    observedSha,
    expectedSha,
    matched: expectedSha === undefined || expectedSha === observedSha,
  };
}

function filterForSrc(src: FileSrc): string[] | undefined {
  if (typeof src === 'string') return undefined;
  if ('github' in src) return src.filter;
  if ('gitlab' in src) return src.filter;
  if ('bitbucket' in src) return src.filter;
  if ('git' in src) return src.filter;
  if ('aws_s3' in src) return src.filter;
  if ('path' in src) return src.filter;
  return undefined;
}

function computeFilesSha(files: Map<string, Buffer>): string {
  // Always include filename in the hash so a rename/path change affects the SHA
  // consistently, whether the source resolves to one file or many.
  const hash = crypto.createHash('sha256');
  const sorted = Array.from(files.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [k, v] of sorted) {
    hash.update(k.replace(/\\/g, '/'), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(v);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function _fetchOneSrcRaw(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
  configBase?: string,
): Promise<{ files: Map<string, Buffer>; skipped?: boolean }> {
  if (isVerbose())
    verbose(
      `fetching source: ${redactUrl(formatSourceLabel(labelForSrc(src, vars)))}`,
    );

  if (typeof src === 'string') {
    const resolved = resolveVars(src, vars);
    const effective =
      configBase !== undefined
        ? resolveRelativeSrc(resolved, configBase)
        : resolved;
    if (effective.startsWith('http://') || effective.startsWith('https://')) {
      const content = await fetchHttp(effective);
      const filename = inferFilenameFromUrl(effective) ?? 'download';
      return { files: new Map([[filename, content]]) };
    }
    if (isGitRemoteUrl(effective)) {
      const { repo, file, ref } = parseGitRemoteSpec(effective);
      return { files: fetchGit(repo, file, ref).files };
    }
    if (effective.startsWith('github:')) {
      let parsedGh: ReturnType<typeof parseGitHubSpec>;
      try {
        parsedGh = parseGitHubSpec(effective);
      } catch {
        throw new Error(
          `Invalid github source spec "${effective}". Expected: github:owner/repo:path/to/file[@ref]`,
        );
      }
      const result = await fetchGitHub(
        parsedGh.repo,
        parsedGh.file,
        parsedGh.ref,
      );
      return { files: result.files };
    }
    if (effective.startsWith('gitlab:')) {
      let parsedGl: ReturnType<typeof parseGitLabSpec>;
      try {
        parsedGl = parseGitLabSpec(effective);
      } catch {
        throw new Error(
          `Invalid gitlab source spec "${effective}". Expected: gitlab:group/project:path/to/file[@ref]`,
        );
      }
      const result = await fetchGitLab(
        parsedGl.project,
        parsedGl.file,
        parsedGl.ref,
      );
      return { files: result.files };
    }
    return { files: fetchLocal(effective, workingDir).files };
  }

  if ('raw' in src) {
    return {
      files: new Map([
        ['output', Buffer.from(resolveVars(src.raw, vars), 'utf8')],
      ]),
    };
  }

  if ('path' in src) {
    const resolved = resolveVars(src.path, vars);
    const result = fetchLocal(resolved, workingDir, src.optional ?? false);
    if (result.missing) {
      return { files: new Map(), skipped: true };
    }
    return { files: result.files };
  }

  if ('url' in src) {
    const resolved = resolveVars(src.url, vars);
    if (isGitRemoteUrl(resolved)) {
      const { repo, file, ref } = parseGitRemoteSpec(resolved);
      try {
        return { files: fetchGit(repo, file, ref).files };
      } catch (err) {
        if (src.optional) return { files: new Map(), skipped: true };
        throw err;
      }
    }
    const content = await fetchHttp(resolved, src.optional ?? false);
    if (content === null) {
      return { files: new Map(), skipped: true };
    }
    const filename = inferFilenameFromUrl(resolved) ?? 'download';
    return { files: new Map([[filename, content]]) };
  }

  let files: Map<string, Buffer>;

  if ('http' in src) {
    const resolvedUrl = resolveVars(src.http, vars);
    const content = await fetchHttp(resolvedUrl);
    const filename = inferFilenameFromUrl(resolvedUrl) ?? 'download';
    files = new Map([[filename, content]]);
  } else if ('exec' in src) {
    files = new Map([
      ['output', fetchExec(resolveVarsShellSafe(src.exec, vars))],
    ]);
  } else if ('gitlab' in src) {
    const host =
      src.gitlab.host !== undefined
        ? resolveVars(src.gitlab.host, vars)
        : undefined;
    let result: { files: Map<string, Buffer> };
    if ('release' in src.gitlab) {
      result = await fetchGitLabRelease(
        resolveVars(src.gitlab.project, vars),
        resolveVars(src.gitlab.release, vars),
        host,
        src.gitlab.via,
      );
    } else {
      result = await fetchGitLab(
        resolveVars(src.gitlab.project, vars),
        resolveVars(src.gitlab.file, vars),
        src.gitlab.ref !== undefined
          ? resolveVars(src.gitlab.ref, vars)
          : undefined,
        host,
        src.gitlab.via,
      );
    }
    files = result.files;
  } else if ('github' in src) {
    const host =
      src.github.host !== undefined
        ? resolveVars(src.github.host, vars)
        : undefined;
    let result: { files: Map<string, Buffer> };
    if ('release' in src.github) {
      result = await fetchGitHubRelease(
        resolveVars(src.github.repo, vars),
        resolveVars(src.github.release, vars),
        host,
        src.github.via,
      );
    } else {
      result = await fetchGitHub(
        resolveVars(src.github.repo, vars),
        resolveVars(src.github.file, vars),
        src.github.ref !== undefined
          ? resolveVars(src.github.ref, vars)
          : undefined,
        host,
        src.github.via,
      );
    }
    files = result.files;
  } else if ('bitbucket' in src) {
    const result = await fetchBitbucket(
      resolveVars(src.bitbucket.workspace, vars),
      resolveVars(src.bitbucket.repo, vars),
      resolveVars(src.bitbucket.file, vars),
      src.bitbucket.ref !== undefined
        ? resolveVars(src.bitbucket.ref, vars)
        : undefined,
      src.bitbucket.host !== undefined
        ? resolveVars(src.bitbucket.host, vars)
        : undefined,
    );
    files = result.files;
  } else if ('git' in src) {
    const result = fetchGit(
      resolveVars(src.git.repo, vars),
      resolveVars(src.git.file, vars),
      src.git.ref !== undefined ? resolveVars(src.git.ref, vars) : undefined,
    );
    files = result.files;
  } else if ('aws_s3' in src) {
    const result = await fetchS3(resolveVars(src.aws_s3, vars));
    files = result.files;
  } else if ('aws_secrets_manager' in src) {
    const result = await fetchSecretsManager(
      resolveVars(src.aws_secrets_manager.name, vars),
      src.aws_secrets_manager.key !== undefined
        ? resolveVars(src.aws_secrets_manager.key, vars) || undefined
        : undefined,
      src.aws_secrets_manager.region !== undefined
        ? resolveVars(src.aws_secrets_manager.region, vars) || undefined
        : undefined,
    );
    files = result.files;
  } else if ('aws_systems_manager_parameter' in src) {
    const result = await fetchSsm(
      resolveVars(src.aws_systems_manager_parameter.name, vars),
      src.aws_systems_manager_parameter.region !== undefined
        ? resolveVars(src.aws_systems_manager_parameter.region, vars) ||
            undefined
        : undefined,
    );
    files = result.files;
  } else if ('vault' in src) {
    const result = await fetchVault(
      resolveVars(src.vault.path, vars),
      src.vault.field !== undefined
        ? resolveVars(src.vault.field, vars)
        : undefined,
    );
    files = result.files;
  } else {
    throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
  }

  return { files };
}

async function fetchOneSrc(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
  cache?: FetchCache,
  getTargetPath: () => string = () => '',
  pendingWrites?: Map<string, Buffer>,
  configBase?: string,
): Promise<{
  files: Map<string, Buffer>;
  record: SourceFetchRecord | null;
  skipped?: boolean;
}> {
  // Evaluate source-level conditions before the cache so a cached result for
  // the same URL is not returned when conditions gate this source out.
  if (typeof src !== 'string') {
    const ifCond = 'if' in src ? (src as { if?: unknown })['if'] : undefined;
    const ifAnyCond =
      'ifAny' in src ? (src as { ifAny?: unknown }).ifAny : undefined;
    if (ifCond !== undefined || ifAnyCond !== undefined) {
      if (
        !evaluateConditions(
          ifCond as Parameters<typeof evaluateConditions>[0],
          ifAnyCond as Parameters<typeof evaluateConditions>[1],
          getTargetPath,
          workingDir,
          vars,
        )
      ) {
        return { files: new Map(), record: null, skipped: true };
      }
    }
  }

  // Check pending writes before hitting the cache: a local path that is also a
  // write target in this run should resolve to the future content, not whatever
  // is on disk (or in the cache from a previous iteration).
  if (pendingWrites !== undefined) {
    const pending = pendingLocalFiles(
      src,
      workingDir,
      vars,
      pendingWrites,
      configBase,
    );
    if (pending !== null) {
      return { files: pending, record: buildRecord(src, pending, vars) };
    }
  }

  const cacheKey = cacheKeyForSrc(src, vars);
  const cached = cache?.get(cacheKey);

  let files: Map<string, Buffer>;
  let skipped: boolean | undefined;

  if (cached !== undefined) {
    if (isVerbose())
      verbose(
        `cache hit: ${redactUrl(formatSourceLabel(labelForSrc(src, vars)))}`,
      );
    files = cached.files;
  } else {
    const raw = await _fetchOneSrcRaw(src, workingDir, vars, configBase);
    files = raw.files;
    skipped = raw.skipped;
    // Don't cache skipped results: if optional changes to required between
    // stabilization iterations, a cached skipped result would mask the error.
    if (!skipped) cache?.set(cacheKey, { files });
  }

  if (skipped) return { files: new Map(), record: null, skipped: true };

  const rawFilter = filterForSrc(src);
  const filterPatterns = rawFilter?.map((p) => resolveVars(p, vars));
  if (filterPatterns && filterPatterns.length > 0) {
    files = applyFilter(files, filterPatterns);
  }

  // Recompute record from the current source spec so expectedSha/matched
  // always reflect the caller's config iteration, not the first fetch.
  return { files, record: buildRecord(src, files, vars) };
}

function pendingLocalFiles(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
  pendingWrites: Map<string, Buffer>,
  configBase?: string,
): Map<string, Buffer> | null {
  let rawPath: string | null = null;
  try {
    if (typeof src === 'string') {
      const resolved = resolveVars(src, vars);
      if (
        !resolved.startsWith('http://') &&
        !resolved.startsWith('https://') &&
        !isGitRemoteUrl(resolved)
      ) {
        const effective =
          configBase !== undefined
            ? resolveRelativeSrc(resolved, configBase)
            : resolved;
        if (
          !effective.startsWith('http://') &&
          !effective.startsWith('https://') &&
          !isGitRemoteUrl(effective) &&
          !effective.startsWith('github:') &&
          !effective.startsWith('gitlab:')
        ) {
          rawPath = effective;
        }
      }
    } else if ('path' in src) {
      rawPath = resolveVars(src.path, vars);
    }
  } catch {
    return null;
  }
  if (rawPath === null) return null;
  return pendingWritesForPath(rawPath, workingDir, pendingWrites);
}

function pendingWritesForPath(
  rawPath: string,
  workingDir: string,
  pendingWrites: Map<string, Buffer>,
): Map<string, Buffer> | null {
  let abs: string;
  if (rawPath.startsWith('~/')) {
    abs = path.resolve(os.homedir(), rawPath.slice(2));
  } else if (path.isAbsolute(rawPath)) {
    abs = rawPath;
  } else {
    abs = path.resolve(workingDir, rawPath);
  }
  if (pendingWrites.has(abs)) {
    return new Map([[path.basename(abs), pendingWrites.get(abs)!]]);
  }
  const prefix = abs + path.sep;
  const dirEntries = [...pendingWrites.entries()].filter(([k]) =>
    k.startsWith(prefix),
  );
  if (dirEntries.length > 0) {
    const files = new Map<string, Buffer>();
    for (const [absPath, content] of dirEntries) {
      files.set(path.relative(abs, absPath), content);
    }
    return files;
  }
  return null;
}

// Asserts that all buffers in the map are text (not binary). Throws with a
// helpful message if any are binary, since merging/concatenating binary files
// is not supported.
function assertTextFiles(files: Map<string, Buffer>, context: string): void {
  for (const [name, buf] of files) {
    if (isBinary(buf)) {
      throw new Error(
        `Binary file "${name}" cannot be used in a multi-source merge (${context}). ` +
          `Use a single src entry for binary files.`,
      );
    }
  }
}

export async function fetchSource(
  entry: FileEntry,
  workingDir: string,
  vars: Variables = {},
  cache?: FetchCache,
  getTargetPathOverride?: () => string,
  pendingWrites?: Map<string, Buffer>,
  configBase?: string,
): Promise<FetchResult> {
  const { src } = entry;

  const getTargetPath =
    getTargetPathOverride ??
    (() => resolveTargetPath(entry, '', workingDir, vars));

  // List src → fetch each, then merge as JSON or concatenate with newline
  if (Array.isArray(src)) {
    const parts: string[] = [];
    const sourceRecords: SourceFetchRecord[] = [];
    for (let i = 0; i < src.length; i++) {
      try {
        const { files, record, skipped } = await fetchOneSrc(
          src[i],
          workingDir,
          vars,
          cache,
          getTargetPath,
          pendingWrites,
          configBase,
        );
        if (skipped) continue;
        assertTextFiles(files, `source ${i}`);
        parts.push(
          Array.from(files.values())
            .map((b) => b.toString('utf8'))
            .join('\n'),
        );
        if (record !== null) sourceRecords.push(record);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[source ${i}] ${msg}`, { cause: err });
      }
    }
    if (parts.length === 0)
      return { files: new Map(), sourceRecords: [], allSkipped: true };
    const filename = path.basename(entry.target);
    const jsonOpts = resolveJsonOptions(entry, src);
    const yamlOpts = jsonOpts === null ? resolveYamlOptions(entry, src) : null;
    const tomlOpts =
      jsonOpts === null && yamlOpts === null
        ? resolveTomlOptions(entry, src)
        : null;
    const iniOpts =
      jsonOpts === null && yamlOpts === null && tomlOpts === null
        ? resolveIniOptions(entry, src)
        : null;
    let content: string;
    if (jsonOpts !== null) {
      content = mergeJson(parts, jsonOpts);
    } else if (yamlOpts !== null) {
      content = mergeYaml(parts, yamlOpts);
    } else if (tomlOpts !== null) {
      content = mergeToml(parts, tomlOpts);
    } else if (iniOpts !== null) {
      content = mergeIni(parts, iniOpts);
    } else {
      content = parts.join('\n');
    }
    return {
      files: new Map([[filename, Buffer.from(content, 'utf8')]]),
      sourceRecords,
    };
  }

  // Single src — delegate dispatch to fetchOneSrc, then apply post-processing
  const {
    files: singleFiles,
    record: singleRecord,
    skipped,
  } = await fetchOneSrc(
    src,
    workingDir,
    vars,
    cache,
    getTargetPath,
    pendingWrites,
    configBase,
  );
  if (skipped) return { files: new Map(), sourceRecords: [], allSkipped: true };

  let resolvedFiles = singleFiles;
  if (entry.extract !== undefined) {
    if (singleFiles.size !== 1) {
      throw new Error(
        `"extract" requires a single-file source, but source returned ${singleFiles.size} file(s)`,
      );
    }
    const [[archiveFilename, archiveBuffer]] = [...singleFiles.entries()];
    if (detectArchiveFormat(archiveFilename) === null) {
      throw new Error(
        `"extract" was specified but "${archiveFilename}" is not a recognised archive format`,
      );
    }
    const extracted = await extractArchive(archiveBuffer, archiveFilename);
    if (entry.extract === true) {
      resolvedFiles = extracted;
    } else {
      const resolvedPatterns = entry.extract.map((p) => resolveVars(p, vars));
      try {
        resolvedFiles = applyFilter(extracted, resolvedPatterns);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith('filter matched no files')
        ) {
          throw new Error(
            `extract matched no entries (${resolvedPatterns.length} pattern${resolvedPatterns.length === 1 ? '' : 's'}: ${resolvedPatterns.map((p) => JSON.stringify(p)).join(', ')})`,
            { cause: err },
          );
        }
        throw err;
      }
    }
  }

  const singleResult = { files: resolvedFiles };
  const sourceRecords: SourceFetchRecord[] =
    singleRecord !== null ? [singleRecord] : [];

  // When a directory source resolves to multiple files but the target is a
  // single file (no trailing slash), merge all files sorted by name instead
  // of clobbering. Auto-detects JSON/YAML from the contained file extensions
  // when no explicit merge option is set.
  const isSingleFileTarget =
    entry.target !== undefined &&
    !entry.target.endsWith('/') &&
    !entry.target.endsWith(path.sep);

  if (singleResult.files.size > 1 && isSingleFileTarget) {
    let dirJsonOpts = resolveJsonOptions(entry, [src]);
    let dirYamlOpts =
      dirJsonOpts === null ? resolveYamlOptions(entry, [src]) : null;
    let dirTomlOpts =
      dirJsonOpts === null && dirYamlOpts === null
        ? resolveTomlOptions(entry, [src])
        : null;
    let dirIniOpts =
      dirJsonOpts === null && dirYamlOpts === null && dirTomlOpts === null
        ? resolveIniOptions(entry, [src])
        : null;

    if (
      dirJsonOpts === null &&
      dirYamlOpts === null &&
      dirTomlOpts === null &&
      dirIniOpts === null
    ) {
      const keys = Array.from(singleResult.files.keys());
      if (
        entry.json !== false &&
        keys.every((k) => JSON_EXTENSIONS.has(path.extname(k).toLowerCase()))
      ) {
        dirJsonOpts = {};
      } else if (
        entry.yaml !== false &&
        keys.every((k) => YAML_EXTENSIONS.has(path.extname(k).toLowerCase()))
      ) {
        dirYamlOpts = {};
      } else if (
        entry.toml !== false &&
        keys.every((k) => TOML_EXTENSIONS.has(path.extname(k).toLowerCase()))
      ) {
        dirTomlOpts = {};
      } else if (
        entry.ini !== false &&
        keys.every((k) => INI_EXTENSIONS.has(path.extname(k).toLowerCase()))
      ) {
        dirIniOpts = {};
      }
    }

    if (
      dirJsonOpts !== null ||
      dirYamlOpts !== null ||
      dirTomlOpts !== null ||
      dirIniOpts !== null
    ) {
      assertTextFiles(singleResult.files, 'directory merge');
      const sortedValues = Array.from(singleResult.files.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, v]) => v.toString('utf8'));
      const filename = path.basename(entry.target);
      let merged: string;
      if (dirJsonOpts !== null) {
        merged = mergeJson(sortedValues, dirJsonOpts);
      } else if (dirYamlOpts !== null) {
        merged = mergeYaml(sortedValues, dirYamlOpts);
      } else if (dirTomlOpts !== null) {
        merged = mergeToml(sortedValues, dirTomlOpts);
      } else {
        merged = mergeIni(sortedValues, dirIniOpts!);
      }
      return {
        files: new Map([[filename, Buffer.from(merged, 'utf8')]]),
        sourceRecords,
      };
    }

    return { ...singleResult, sourceRecords };
  }

  const singleJsonOpts = resolveJsonOptions(entry, [src]);
  const singleYamlOpts =
    singleJsonOpts === null ? resolveYamlOptions(entry, [src]) : null;
  const singleTomlOpts =
    singleJsonOpts === null && singleYamlOpts === null
      ? resolveTomlOptions(entry, [src])
      : null;
  const singleIniOpts =
    singleJsonOpts === null &&
    singleYamlOpts === null &&
    singleTomlOpts === null
      ? resolveIniOptions(entry, [src])
      : null;

  if (
    singleJsonOpts === null &&
    singleYamlOpts === null &&
    singleTomlOpts === null &&
    singleIniOpts === null
  )
    return { ...singleResult, sourceRecords };

  const formatted = new Map<string, Buffer>();
  for (const [k, v] of singleResult.files) {
    if (isBinary(v)) {
      const fmtName =
        singleJsonOpts !== null
          ? 'json'
          : singleYamlOpts !== null
            ? 'yaml'
            : singleTomlOpts !== null
              ? 'toml'
              : 'ini';
      throw new Error(
        `Binary file "${k}" cannot be formatted as ${fmtName}. Remove the format option or use a text source.`,
      );
    }
    const text = v.toString('utf8');
    if (singleJsonOpts !== null) {
      formatted.set(k, Buffer.from(formatJson(text, singleJsonOpts), 'utf8'));
    } else if (singleYamlOpts !== null) {
      formatted.set(k, Buffer.from(formatYaml(text), 'utf8'));
    } else if (singleTomlOpts !== null) {
      formatted.set(k, Buffer.from(formatToml(text), 'utf8'));
    } else {
      formatted.set(k, Buffer.from(formatIni(text), 'utf8'));
    }
  }
  return { files: formatted, sourceRecords };
}

export const _testable = { srcFilename };
