import * as path from 'path';
import {
  DIRECTORY_FETCH_CONCURRENCY,
  mapWithConcurrency,
} from '../../concurrency';
import type { Via } from '../../types';
import { normalizeVia } from '../forge/transport';
import { fetchDirectoryViaArchive } from './archive';
import type { GitLabResult } from './client';
import { detectPathType, fetchFile, listTree } from './files';
import { resolveRef } from './ref';

export async function fetchGitLab(
  project: string,
  file: string,
  ref: string | undefined,
  host?: string,
  via?: Via | Via[],
): Promise<GitLabResult> {
  const transports = normalizeVia(via);
  const resolvedRef = await resolveRef(project, ref, host, transports);
  const normalizedPath = file.replace(/\/$/, '');
  const isDirectory =
    file.endsWith('/') ||
    (await detectPathType(
      project,
      normalizedPath,
      resolvedRef,
      host,
      transports,
    )) === 'directory';

  if (!isDirectory) {
    const content = await fetchFile(
      project,
      normalizedPath,
      resolvedRef,
      host,
      transports,
    );
    return { files: new Map([[path.basename(normalizedPath), content]]) };
  }

  // Directory — archive approach first (one API call), then fall back to per-file fetches
  const archived = await fetchDirectoryViaArchive(
    project,
    normalizedPath,
    resolvedRef,
    host,
    transports,
  );
  if (archived) return { files: archived };

  const paths = await listTree(
    project,
    normalizedPath,
    resolvedRef,
    host,
    transports,
  );
  if (!paths.length) {
    throw new Error(
      `Failed to fetch ${file} from ${project}@${resolvedRef} (not a file or empty directory)`,
    );
  }
  const entries = await mapWithConcurrency(
    paths,
    DIRECTORY_FETCH_CONCURRENCY,
    async (p): Promise<[string, Buffer]> => [
      path.relative(normalizedPath, p),
      await fetchFile(project, p, resolvedRef, host, transports),
    ],
  );
  return { files: new Map(entries) };
}
