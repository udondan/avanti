import * as path from 'path';
import {
  FileEntry,
  FileSrc,
  JsonMergeOptions,
  YamlMergeOptions,
  Variables,
} from '../types';
import { resolveVars } from '../variables';
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
): Promise<string> {
  if (typeof src === 'string') {
    const resolved = resolveVars(src, vars);
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      return fetchHttp(resolved);
    }
    const result = fetchLocal(resolved, workingDir);
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('raw' in src) {
    return resolveVars(src.raw, vars);
  }

  if ('exec' in src) {
    return fetchExec(resolveVars(src.exec, vars));
  }

  if ('gitlab' in src) {
    const result = await fetchGitLab(
      resolveVars(src.gitlab.project, vars),
      resolveVars(src.gitlab.file, vars),
      src.gitlab.ref !== undefined
        ? resolveVars(src.gitlab.ref, vars)
        : undefined,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('github' in src) {
    const result = await fetchGitHub(
      resolveVars(src.github.repo, vars),
      resolveVars(src.github.file, vars),
      src.github.ref !== undefined
        ? resolveVars(src.github.ref, vars)
        : undefined,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('bitbucket' in src) {
    const result = await fetchBitbucket(
      resolveVars(src.bitbucket.workspace, vars),
      resolveVars(src.bitbucket.repo, vars),
      resolveVars(src.bitbucket.file, vars),
      src.bitbucket.ref !== undefined
        ? resolveVars(src.bitbucket.ref, vars)
        : undefined,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('git' in src) {
    const result = fetchGit(
      resolveVars(src.git.repo, vars),
      resolveVars(src.git.file, vars),
      src.git.ref !== undefined ? resolveVars(src.git.ref, vars) : undefined,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('s3' in src) {
    const result = fetchS3(resolveVars(src.s3, vars));
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('vault' in src) {
    const result = await fetchVault(
      resolveVars(src.vault.path, vars),
      src.vault.field !== undefined
        ? resolveVars(src.vault.field, vars)
        : undefined,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
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
        parts.push(await fetchOneSrc(src[i], workingDir, vars));
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

  // Single src — fetch then optionally format as JSON
  let singleResult: FetchResult;

  if (typeof src === 'string') {
    const resolved = resolveVars(src, vars);
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      const content = await fetchHttp(resolved);
      const filename = entry.target
        ? path.basename(entry.target)
        : (inferFilenameFromUrl(resolved) ?? 'download');
      singleResult = { files: new Map([[filename, content]]) };
    } else {
      // Local path (absolute, ~/, or relative)
      const result = fetchLocal(resolved, workingDir);
      singleResult = { files: result.files };
    }
  } else if ('raw' in src) {
    const filename = path.basename(entry.target!);
    singleResult = {
      files: new Map([[filename, resolveVars(src.raw, vars)]]),
    };
  } else if ('exec' in src) {
    const content = fetchExec(resolveVars(src.exec, vars));
    const filename = path.basename(entry.target!);
    singleResult = { files: new Map([[filename, content]]) };
  } else if ('gitlab' in src) {
    const result = await fetchGitLab(
      resolveVars(src.gitlab.project, vars),
      resolveVars(src.gitlab.file, vars),
      src.gitlab.ref !== undefined
        ? resolveVars(src.gitlab.ref, vars)
        : undefined,
    );
    singleResult = { files: result.files };
  } else if ('github' in src) {
    const result = await fetchGitHub(
      resolveVars(src.github.repo, vars),
      resolveVars(src.github.file, vars),
      src.github.ref !== undefined
        ? resolveVars(src.github.ref, vars)
        : undefined,
    );
    singleResult = { files: result.files };
  } else if ('bitbucket' in src) {
    const result = await fetchBitbucket(
      resolveVars(src.bitbucket.workspace, vars),
      resolveVars(src.bitbucket.repo, vars),
      resolveVars(src.bitbucket.file, vars),
      src.bitbucket.ref !== undefined
        ? resolveVars(src.bitbucket.ref, vars)
        : undefined,
    );
    singleResult = { files: result.files };
  } else if ('git' in src) {
    const result = fetchGit(
      resolveVars(src.git.repo, vars),
      resolveVars(src.git.file, vars),
      src.git.ref !== undefined ? resolveVars(src.git.ref, vars) : undefined,
    );
    singleResult = { files: result.files };
  } else if ('s3' in src) {
    const result = fetchS3(resolveVars(src.s3, vars));
    singleResult = { files: result.files };
  } else if ('vault' in src) {
    const result = await fetchVault(
      resolveVars(src.vault.path, vars),
      src.vault.field !== undefined
        ? resolveVars(src.vault.field, vars)
        : undefined,
    );
    singleResult = { files: result.files };
  } else {
    throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
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
