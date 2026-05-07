import * as path from 'path';
import { FileEntry, FileSrc, Variables } from '../types';
import { resolveVars } from '../variables';
import { fetchHttp, inferFilenameFromUrl } from './http';
import { fetchLocal } from './local';
import { fetchExec } from './exec';
import { fetchGitLab } from './gitlab';
import { fetchGitHub } from './github';
import { mergeJson, formatJson } from '../processors/json';

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
    const content = entry.json
      ? mergeJson(parts, entry.json)
      : parts.join('\n');
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
  } else {
    throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
  }

  if (!entry.json) return singleResult;

  const formatted = new Map<string, string>();
  for (const [k, v] of singleResult.files) {
    formatted.set(k, formatJson(v));
  }
  return { files: formatted };
}
