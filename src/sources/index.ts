import * as crypto from 'crypto';
import * as path from 'path';
import {
  FileEntry,
  FileSrc,
  JsonMergeOptions,
  YamlMergeOptions,
  Variables,
} from '../types';
import { resolveVars, resolveVarsShellSafe } from '../variables';
import { fetchHttp, inferFilenameFromUrl } from './http';
import { fetchLocal } from './local';
import { fetchExec } from './exec';
import { fetchGitLab } from './gitlab';
import { fetchGitHub } from './github';
import { fetchBitbucket } from './bitbucket';
import { fetchGit } from './git';
import { fetchS3 } from './s3';
import { fetchVault } from './vault';
import { mergeJson, formatJson } from '../processors/json';
import { mergeYaml, formatYaml } from '../processors/yaml';

const JSON_EXTENSIONS = new Set(['.json', '.jsonc']);
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

function srcFilename(src: FileSrc): string | null {
  if (typeof src === 'string') {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      try {
        return new URL(src).pathname;
      } catch {
        return src;
      }
    }
    return src;
  }
  if ('gitlab' in src) return src.gitlab.file;
  if ('github' in src) return src.github.file;
  if ('bitbucket' in src) return src.bitbucket.file;
  if ('git' in src) return src.git.file;
  if ('s3' in src) return src.s3;
  if ('http' in src) {
    try {
      return new URL(src.http).pathname;
    } catch {
      return src.http; // variable-driven URL; pathname unavailable at parse time
    }
  }
  if ('path' in src) return src.path;
  if ('url' in src) {
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

function resolveJsonOptions(
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

function resolveYamlOptions(
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

export interface SourceFetchRecord {
  sourceLabel: string;
  observedSha: string;
  expectedSha: string | undefined;
  matched: boolean;
}

export interface FetchResult {
  files: Map<string, string>;
  sourceRecords: SourceFetchRecord[];
}

export type FetchCache = Map<
  string,
  { files: Map<string, string>; skipped?: boolean }
>;

// labelForSrc returns the raw (unresolved) source label used in SourceFetchRecord
// and matched by applyUpdatedShas against the literal YAML values in the config file.
function labelForSrc(src: FileSrc, vars: Variables): string {
  if (typeof src === 'string') return resolveVars(src, vars);
  if ('github' in src) {
    const ref = src.github.ref ? `@${src.github.ref}` : '';
    return `github:${src.github.repo}:${src.github.file}${ref}`;
  }
  if ('gitlab' in src) {
    const ref = src.gitlab.ref ? `@${src.gitlab.ref}` : '';
    return `gitlab:${src.gitlab.project}:${src.gitlab.file}${ref}`;
  }
  if ('bitbucket' in src) {
    const ref = src.bitbucket.ref ? `@${src.bitbucket.ref}` : '';
    return `bitbucket:${src.bitbucket.workspace}/${src.bitbucket.repo}:${src.bitbucket.file}${ref}`;
  }
  if ('git' in src) {
    const ref = src.git.ref ? `@${src.git.ref}` : '';
    return `git:${src.git.repo}:${src.git.file}${ref}`;
  }
  if ('exec' in src) return `exec:${src.exec}`;
  if ('s3' in src) return `s3:${src.s3}`;
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
  if (typeof src === 'string') return resolveVars(src, vars);
  if ('github' in src) {
    const ref = src.github.ref ? `@${resolveVars(src.github.ref, vars)}` : '';
    return `github:${resolveVars(src.github.repo, vars)}:${resolveVars(src.github.file, vars)}${ref}`;
  }
  if ('gitlab' in src) {
    const ref = src.gitlab.ref ? `@${resolveVars(src.gitlab.ref, vars)}` : '';
    return `gitlab:${resolveVars(src.gitlab.project, vars)}:${resolveVars(src.gitlab.file, vars)}${ref}`;
  }
  if ('bitbucket' in src) {
    const ref = src.bitbucket.ref
      ? `@${resolveVars(src.bitbucket.ref, vars)}`
      : '';
    return `bitbucket:${resolveVars(src.bitbucket.workspace, vars)}/${resolveVars(src.bitbucket.repo, vars)}:${resolveVars(src.bitbucket.file, vars)}${ref}`;
  }
  if ('git' in src) {
    const ref = src.git.ref ? `@${resolveVars(src.git.ref, vars)}` : '';
    return `git:${resolveVars(src.git.repo, vars)}:${resolveVars(src.git.file, vars)}${ref}`;
  }
  if ('exec' in src) return `exec:${resolveVars(src.exec, vars)}`;
  if ('s3' in src) return `s3:${resolveVars(src.s3, vars)}`;
  if ('vault' in src) {
    const field = src.vault.field
      ? `#${resolveVars(src.vault.field, vars)}`
      : '';
    return `vault:${resolveVars(src.vault.path, vars)}${field}`;
  }
  if ('http' in src) return `http:${resolveVars(src.http, vars)}`;
  if ('path' in src) return `path:${resolveVars(src.path, vars)}`;
  if ('url' in src) return `url:${resolveVars(src.url, vars)}`;
  // raw: key includes the resolved content so distinct raw values don't collide
  if ('raw' in src) return `raw:${resolveVars(src.raw, vars)}`;
  return JSON.stringify(src);
}

function expectedShaForSrc(src: FileSrc): string | undefined {
  if (typeof src === 'string') return undefined;
  if ('github' in src) return src.github.sha;
  if ('gitlab' in src) return src.gitlab.sha;
  if ('bitbucket' in src) return src.bitbucket.sha;
  if ('git' in src) return src.git.sha;
  if ('exec' in src) return src.sha;
  if ('s3' in src) return src.sha;
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
  files: Map<string, string>,
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

function computeFilesSha(files: Map<string, string>): string {
  // Always include filename in the hash so a rename/path change affects the SHA
  // consistently, whether the source resolves to one file or many.
  const hash = crypto.createHash('sha256');
  const sorted = Array.from(files.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [k, v] of sorted) {
    hash.update(k.replace(/\\/g, '/'), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(v, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function _fetchOneSrcRaw(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
): Promise<{
  files: Map<string, string>;
  record: SourceFetchRecord | null;
  skipped?: boolean;
}> {
  if (typeof src === 'string') {
    const resolved = resolveVars(src, vars);
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      const content = await fetchHttp(resolved);
      const filename = inferFilenameFromUrl(resolved) ?? 'download';
      return {
        files: new Map([[filename, content]]),
        record: null,
      };
    }
    return { files: fetchLocal(resolved, workingDir).files, record: null };
  }

  if ('raw' in src) {
    return {
      files: new Map([['output', resolveVars(src.raw, vars)]]),
      record: null,
    };
  }

  if ('path' in src) {
    const resolved = resolveVars(src.path, vars);
    const result = fetchLocal(resolved, workingDir, src.optional ?? false);
    if (result.missing) {
      return { files: new Map(), record: null, skipped: true };
    }
    const observedSha = computeFilesSha(result.files);
    const expectedSha = src.sha;
    const record: SourceFetchRecord = {
      sourceLabel: labelForSrc(src, vars),
      observedSha,
      expectedSha,
      matched: expectedSha === undefined || expectedSha === observedSha,
    };
    return { files: result.files, record };
  }

  if ('url' in src) {
    const resolved = resolveVars(src.url, vars);
    const content = await fetchHttp(resolved, src.optional ?? false);
    if (content === null) {
      return { files: new Map(), record: null, skipped: true };
    }
    const filename = inferFilenameFromUrl(resolved) ?? 'download';
    const files = new Map([[filename, content]]);
    const observedSha = computeFilesSha(files);
    const expectedSha = src.sha;
    const record: SourceFetchRecord = {
      sourceLabel: labelForSrc(src, vars),
      observedSha,
      expectedSha,
      matched: expectedSha === undefined || expectedSha === observedSha,
    };
    return { files, record };
  }

  let files: Map<string, string>;

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
    const result = await fetchGitLab(
      resolveVars(src.gitlab.project, vars),
      resolveVars(src.gitlab.file, vars),
      src.gitlab.ref !== undefined
        ? resolveVars(src.gitlab.ref, vars)
        : undefined,
    );
    files = result.files;
  } else if ('github' in src) {
    const result = await fetchGitHub(
      resolveVars(src.github.repo, vars),
      resolveVars(src.github.file, vars),
      src.github.ref !== undefined
        ? resolveVars(src.github.ref, vars)
        : undefined,
    );
    files = result.files;
  } else if ('bitbucket' in src) {
    const result = await fetchBitbucket(
      resolveVars(src.bitbucket.workspace, vars),
      resolveVars(src.bitbucket.repo, vars),
      resolveVars(src.bitbucket.file, vars),
      src.bitbucket.ref !== undefined
        ? resolveVars(src.bitbucket.ref, vars)
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
  } else if ('s3' in src) {
    const result = fetchS3(resolveVars(src.s3, vars));
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

  const observedSha = computeFilesSha(files);
  const expectedSha = shaSupported(src) ? expectedShaForSrc(src) : undefined;
  const record: SourceFetchRecord = {
    sourceLabel: labelForSrc(src, vars),
    observedSha,
    expectedSha,
    matched: expectedSha === undefined || expectedSha === observedSha,
  };

  return { files, record };
}

async function fetchOneSrc(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
  cache?: FetchCache,
): Promise<{
  files: Map<string, string>;
  record: SourceFetchRecord | null;
  skipped?: boolean;
}> {
  const cacheKey = cacheKeyForSrc(src, vars);
  const cached = cache?.get(cacheKey);

  let files: Map<string, string>;
  let skipped: boolean | undefined;

  if (cached !== undefined) {
    files = cached.files;
    skipped = cached.skipped;
  } else {
    const raw = await _fetchOneSrcRaw(src, workingDir, vars);
    files = raw.files;
    skipped = raw.skipped;
    cache?.set(cacheKey, { files, skipped });
  }

  if (skipped) return { files: new Map(), record: null, skipped: true };
  // Recompute record from the current source spec so expectedSha/matched
  // always reflect the caller's config iteration, not the first fetch.
  return { files, record: buildRecord(src, files, vars) };
}

export async function fetchSource(
  entry: FileEntry,
  workingDir: string,
  vars: Variables = {},
  cache?: FetchCache,
): Promise<FetchResult> {
  const { src } = entry;

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
        );
        if (skipped) continue;
        parts.push(Array.from(files.values()).join('\n'));
        if (record !== null) sourceRecords.push(record);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[source ${i}] ${msg}`, { cause: err });
      }
    }
    if (parts.length === 0) return { files: new Map(), sourceRecords: [] };
    const filename = path.basename(entry.target);
    const jsonOpts = resolveJsonOptions(entry, src);
    const yamlOpts = jsonOpts === null ? resolveYamlOptions(entry, src) : null;
    let content: string;
    if (jsonOpts !== null) {
      content = mergeJson(parts, jsonOpts);
    } else if (yamlOpts !== null) {
      content = mergeYaml(parts, yamlOpts);
    } else {
      content = parts.join('\n');
    }
    return { files: new Map([[filename, content]]), sourceRecords };
  }

  // Single src — delegate dispatch to fetchOneSrc, then apply post-processing
  const {
    files: singleFiles,
    record: singleRecord,
    skipped,
  } = await fetchOneSrc(src, workingDir, vars, cache);
  if (skipped) return { files: new Map(), sourceRecords: [] };
  const singleResult = { files: singleFiles };
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

    if (dirJsonOpts === null && dirYamlOpts === null) {
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
      }
    }

    if (dirJsonOpts !== null || dirYamlOpts !== null) {
      const sortedValues = Array.from(singleResult.files.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, v]) => v);
      const filename = path.basename(entry.target);
      const merged =
        dirJsonOpts !== null
          ? mergeJson(sortedValues, dirJsonOpts)
          : mergeYaml(sortedValues, dirYamlOpts!);
      return { files: new Map([[filename, merged]]), sourceRecords };
    }

    return { ...singleResult, sourceRecords };
  }

  const singleJsonOpts = resolveJsonOptions(entry, [src]);
  const singleYamlOpts =
    singleJsonOpts === null ? resolveYamlOptions(entry, [src]) : null;

  if (singleJsonOpts === null && singleYamlOpts === null)
    return { ...singleResult, sourceRecords };

  const formatted = new Map<string, string>();
  for (const [k, v] of singleResult.files) {
    if (singleJsonOpts !== null) {
      formatted.set(k, formatJson(v));
    } else {
      formatted.set(k, formatYaml(v));
    }
  }
  return { files: formatted, sourceRecords };
}
