import * as path from 'path';
import { FileEntry, FileSrc } from '../types';
import { fetchHttp, inferFilenameFromUrl } from './http';
import { fetchLocal } from './local';
import { fetchExec } from './exec';
import { fetchGitLab } from './gitlab';
import { fetchGitHub } from './github';

export interface FetchResult {
  files: Map<string, string>;
}

async function fetchOneSrc(src: FileSrc, workingDir: string): Promise<string> {
  if (typeof src === 'string') {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return fetchHttp(src);
    }
    const result = fetchLocal(src, workingDir);
    // For a single-file local result, return the first (and only) value
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('raw' in src) {
    return src.raw;
  }

  if ('exec' in src) {
    return fetchExec(src.exec);
  }

  if ('gitlab' in src) {
    const result = fetchGitLab(
      src.gitlab.project,
      src.gitlab.file,
      src.gitlab.ref,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  if ('github' in src) {
    const result = fetchGitHub(
      src.github.repo,
      src.github.file,
      src.github.ref,
    );
    const values = Array.from(result.files.values());
    return values.join('\n');
  }

  throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
}

export async function fetchSource(
  entry: FileEntry,
  workingDir: string,
): Promise<FetchResult> {
  const { src } = entry;

  // List src → fetch each, concatenate with newline
  if (Array.isArray(src)) {
    const parts: string[] = [];
    for (let i = 0; i < src.length; i++) {
      try {
        parts.push(await fetchOneSrc(src[i], workingDir));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[source ${i}] ${msg}`, { cause: err });
      }
    }
    const filename = path.basename(entry.target!);
    return { files: new Map([[filename, parts.join('\n')]]) };
  }

  // Single src — original behaviour
  if (typeof src === 'string') {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const content = await fetchHttp(src);
      const filename = entry.target
        ? path.basename(entry.target)
        : (inferFilenameFromUrl(src) ?? 'download');
      return { files: new Map([[filename, content]]) };
    }

    // Local path (absolute, ~/, or relative)
    const result = fetchLocal(src, workingDir);
    return { files: result.files };
  }

  // Map sources
  if ('raw' in src) {
    const filename = path.basename(entry.target!);
    return { files: new Map([[filename, src.raw]]) };
  }

  if ('exec' in src) {
    const content = fetchExec(src.exec);
    const filename = path.basename(entry.target!); // target required, validated in config
    return { files: new Map([[filename, content]]) };
  }

  if ('gitlab' in src) {
    const result = fetchGitLab(
      src.gitlab.project,
      src.gitlab.file,
      src.gitlab.ref,
    );
    return { files: result.files };
  }

  if ('github' in src) {
    const result = fetchGitHub(
      src.github.repo,
      src.github.file,
      src.github.ref,
    );
    return { files: result.files };
  }

  throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
}
