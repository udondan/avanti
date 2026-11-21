import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verbose } from '../../logger';
import type { Via } from '../../types';
import {
  cliFallbackAllowed,
  fetchApi,
  isNetworkError,
  statusFallback,
} from '../forge/transport';
import {
  apiHeaders,
  GLAB,
  glabApiBinary,
  projectApiUrl,
  projectEndpoint,
} from './client';

function collectFiles(
  baseDir: string,
  dir: string,
  files: Map<string, Buffer>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(baseDir, full, files);
    } else if (entry.isFile()) {
      files.set(path.relative(baseDir, full), fs.readFileSync(full));
    }
  }
}

function extractArchive(
  buf: Buffer,
  dirPath: string,
): Map<string, Buffer> | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-gl-'));
  try {
    const archivePath = path.join(tmpDir, 'archive.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.writeFileSync(archivePath, buf);
    fs.mkdirSync(extractDir);

    const tarResult = spawnSync(
      'tar',
      ['-xzf', archivePath, '-C', extractDir],
      {
        encoding: 'utf8',
      },
    );
    if (tarResult.status !== 0) return null;

    const rootEntries = fs.readdirSync(extractDir);
    if (rootEntries.length !== 1) return null;

    const targetDir = path.join(extractDir, rootEntries[0], dirPath);
    if (!fs.existsSync(targetDir)) return null;

    const files = new Map<string, Buffer>();
    collectFiles(targetDir, targetDir, files);
    return files.size > 0 ? files : null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function archiveSuffix(dirPath: string, ref: string): string {
  return `repository/archive.tar.gz?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(dirPath)}`;
}

async function fetchDirectoryViaArchiveViaApi(
  project: string,
  dirPath: string,
  ref: string,
  host: string | undefined,
  withCliFallback: boolean,
): Promise<Map<string, Buffer> | null> {
  let res: Response | null;
  try {
    res = await fetchApi(
      GLAB,
      projectApiUrl(project, archiveSuffix(dirPath, ref), host),
      { headers: apiHeaders() },
      withCliFallback,
    );
  } catch (e) {
    if (isNetworkError(e)) return null;
    throw e;
  }
  if (!res || (!res.ok && statusFallback(GLAB, res.status, withCliFallback))) {
    return fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
  }
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? extractArchive(buf, dirPath) : null;
}

export async function fetchDirectoryViaArchive(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
  transports: Via[] = ['api', 'cli'],
): Promise<Map<string, Buffer> | null> {
  verbose(
    `gitlab: fetching directory via archive: ${project}:${dirPath}@${ref}`,
  );

  if (transports[0] === 'cli') {
    const result = fetchDirectoryViaArchiveViaCli(project, dirPath, ref, host);
    if (result !== null || !transports.includes('api')) return result;
  }

  return fetchDirectoryViaArchiveViaApi(
    project,
    dirPath,
    ref,
    host,
    cliFallbackAllowed(transports),
  );
}

function fetchDirectoryViaArchiveViaCli(
  project: string,
  dirPath: string,
  ref: string,
  host?: string,
): Map<string, Buffer> | null {
  const endpoint = projectEndpoint(project, archiveSuffix(dirPath, ref));
  let res: ReturnType<typeof glabApiBinary>;
  try {
    res = glabApiBinary(endpoint, host);
  } catch {
    return null;
  }
  if (res.status !== 0 || !res.stdout.length) return null;
  return extractArchive(res.stdout, dirPath);
}
