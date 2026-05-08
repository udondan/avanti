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

export interface FetchResult {
  files: Map<string, string>;
}

async function fetchOneSrc(
  src: FileSrc,
  workingDir: string,
  vars: Variables,
): Promise<FetchResult> {
  if (typeof src === 'string') {
    const resolved = resolveVars(src, vars);
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      const content = await fetchHttp(resolved);
      const filename = inferFilenameFromUrl(resolved) ?? 'download';
      return { files: new Map([[filename, content]]) };
    }
    return fetchLocal(resolved, workingDir);
  }

  if ('raw' in src) {
    return { files: new Map([['output', resolveVars(src.raw, vars)]]) };
  }

  if ('exec' in src) {
    return {
      files: new Map([
        ['output', fetchExec(resolveVarsShellSafe(src.exec, vars))],
      ]),
    };
  }

  if ('gitlab' in src) {
    return fetchGitLab(
      resolveVars(src.gitlab.project, vars),
      resolveVars(src.gitlab.file, vars),
      src.gitlab.ref !== undefined
        ? resolveVars(src.gitlab.ref, vars)
        : undefined,
    );
  }

  if ('github' in src) {
    return fetchGitHub(
      resolveVars(src.github.repo, vars),
      resolveVars(src.github.file, vars),
      src.github.ref !== undefined
        ? resolveVars(src.github.ref, vars)
        : undefined,
    );
  }

  if ('bitbucket' in src) {
    return fetchBitbucket(
      resolveVars(src.bitbucket.workspace, vars),
      resolveVars(src.bitbucket.repo, vars),
      resolveVars(src.bitbucket.file, vars),
      src.bitbucket.ref !== undefined
        ? resolveVars(src.bitbucket.ref, vars)
        : undefined,
    );
  }

  if ('git' in src) {
    return fetchGit(
      resolveVars(src.git.repo, vars),
      resolveVars(src.git.file, vars),
      src.git.ref !== undefined ? resolveVars(src.git.ref, vars) : undefined,
    );
  }

  if ('s3' in src) {
    return fetchS3(resolveVars(src.s3, vars));
  }

  if ('vault' in src) {
    return fetchVault(
      resolveVars(src.vault.path, vars),
      src.vault.field !== undefined
        ? resolveVars(src.vault.field, vars)
        : undefined,
    );
  }

  throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
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
    for (let i = 0; i < src.length; i++) {
      try {
        const result = await fetchOneSrc(src[i], workingDir, vars);
        parts.push(Array.from(result.files.values()).join('\n'));
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
    return { files: new Map([[filename, content]]) };
  }

  // Single src — delegate dispatch to fetchOneSrc, then apply post-processing
  const singleResult = await fetchOneSrc(src, workingDir, vars);

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
      return { files: new Map([[filename, merged]]) };
    }

    return singleResult;
  }

  const singleJsonOpts = resolveJsonOptions(entry, [src]);
  const singleYamlOpts =
    singleJsonOpts === null ? resolveYamlOptions(entry, [src]) : null;

  if (singleJsonOpts === null && singleYamlOpts === null) return singleResult;

  const formatted = new Map<string, string>();
  for (const [k, v] of singleResult.files) {
    if (singleJsonOpts !== null) {
      formatted.set(k, formatJson(v));
    } else {
      formatted.set(k, formatYaml(v));
    }
  }
  return { files: formatted };
}
