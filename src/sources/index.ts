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
  if (typeof src === 'string') return src;
  if ('gitlab' in src) return src.gitlab.file;
  if ('github' in src) return src.github.file;
  if ('bitbucket' in src) return src.bitbucket.file;
  if ('git' in src) return src.git.file;
  if ('s3' in src) return src.s3;
  if ('http' in src) return src.http;
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
  if ('raw' in src) return 'raw';
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
  return undefined;
}

function shaSupported(src: FileSrc): boolean {
  if (typeof src === 'string') return false; // local paths excluded; plain string HTTP has no sha field
  if ('raw' in src) return false;
  return true;
}

function computeFilesSha(files: Map<string, string>): string {
  // Always include filename in the hash so a rename/path change affects the SHA
  // consistently, whether the source resolves to one file or many.
  const hash = crypto.createHash('sha256');
  const sorted = Array.from(files.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [k, v] of sorted) {
    hash.update(k, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(v, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function fetchOneSrc(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
): Promise<{ files: Map<string, string>; record: SourceFetchRecord | null }> {
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

export async function fetchSource(
  entry: FileEntry,
  workingDir: string,
  vars: Variables = {},
): Promise<FetchResult> {
  const { src } = entry;

  // List src → fetch each, then merge as JSON or concatenate with newline
  if (Array.isArray(src)) {
    const parts: string[] = [];
    const sourceRecords: SourceFetchRecord[] = [];
    for (let i = 0; i < src.length; i++) {
      try {
        const { files, record } = await fetchOneSrc(src[i], workingDir, vars);
        parts.push(Array.from(files.values()).join('\n'));
        if (record !== null) sourceRecords.push(record);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[source ${i}] ${msg}`, { cause: err });
      }
    }
    const filename = path.basename(entry.target!);
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
  const { files: singleFiles, record: singleRecord } = await fetchOneSrc(
    src,
    workingDir,
    vars,
  );
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
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => v);
      const filename = path.basename(entry.target!);
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
