import { spawnSync } from 'child_process';
import { fetchWithRetry } from '../../fetch';
import { verbose } from '../../logger';
import { type ForgeCli, firstNonEmpty, HttpError } from '../forge/transport';

export interface GitHubResult {
  files: Map<string, Buffer>;
}

export function getApiBase(override?: string): string {
  const host = firstNonEmpty(override, process.env.GITHUB_HOST) ?? '';
  return host ? `https://${host}/api/v3` : 'https://api.github.com';
}

export function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'avanti',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** GET a GitHub API path (relative to the API base) with the default headers. */
export function apiGet(host: string | undefined, apiPath: string) {
  return fetchWithRetry(`${getApiBase(host)}/${apiPath}`, {
    headers: apiHeaders(),
  });
}

async function getErrorDetail(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('json')) return '';
  const body = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  return typeof body?.message === 'string' && body.message
    ? `: ${body.message}`
    : '';
}

export async function githubHttpError(
  res: Response,
  context: string,
): Promise<HttpError> {
  const detail = await getErrorDetail(res);
  return new HttpError(res.status, `${context}: HTTP ${res.status}${detail}`);
}

function isGhAvailable(): boolean {
  return !spawnSync('gh', ['--version'], { encoding: 'utf8' }).error;
}

export const GH: ForgeCli = {
  prefix: 'github',
  cli: 'gh',
  isAvailable: isGhAvailable,
};

export function ghRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`gh error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/** Runs `gh api [--hostname <host>] <endpoint> --jq <jq>` and logs the command. */
export function ghApi(
  endpoint: string,
  jq: string,
  host: string | undefined,
  label: string,
  extraArgs: string[] = [],
): ReturnType<typeof ghRun> {
  const args = [
    'api',
    ...hostnameArgs(host),
    ...extraArgs,
    endpoint,
    '--jq',
    jq,
  ];
  verbose(`github: ${label}: gh ${args.join(' ')}`);
  return ghRun(args);
}

export function hostnameArgs(host?: string): string[] {
  const resolved = firstNonEmpty(host, process.env.GITHUB_HOST) ?? '';
  return resolved ? ['--hostname', resolved] : [];
}

export function encodeFilePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}
