import { spawnSync } from 'child_process';
import { verbose } from '../../logger';
import { firstNonEmpty, type ForgeCli } from '../forge/transport';

export interface GitLabResult {
  /** Map of relative path → content */
  files: Map<string, Buffer>;
}

type GlabResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

type GlabBinaryResult = {
  stdout: Buffer;
  stderr: string;
  status: number | null;
};

export const PER_PAGE = 100;

export function getHost(override?: string): string {
  return firstNonEmpty(override, process.env.GITLAB_HOST) ?? 'gitlab.com';
}

export function envToken(): string | undefined {
  return process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN;
}

export function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'avanti' };
  const token = envToken();
  if (token) headers['PRIVATE-TOKEN'] = token;
  return headers;
}

/** Project-scoped API endpoint path, e.g. `projects/<id>/<suffix>` (used by glab api). */
export function projectEndpoint(project: string, suffix: string): string {
  return `projects/${encodeURIComponent(project)}/${suffix}`;
}

/** Absolute project-scoped REST API URL. */
export function projectApiUrl(
  project: string,
  suffix: string,
  host?: string,
): string {
  return `https://${getHost(host)}/api/v4/${projectEndpoint(project, suffix)}`;
}

function isGlabAvailable(): boolean {
  return !spawnSync('glab', ['--version'], { encoding: 'utf8' }).error;
}

export const GLAB: ForgeCli = {
  prefix: 'gitlab',
  cli: 'glab',
  isAvailable: isGlabAvailable,
};

export function hostnameArgs(host?: string): string[] {
  const resolved = firstNonEmpty(host, process.env.GITLAB_HOST);
  return resolved ? ['--hostname', resolved] : [];
}

function glabRun(args: string[]): GlabResult {
  const result = spawnSync('glab', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`glab error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function glabRunBinary(args: string[]): GlabBinaryResult {
  const result = spawnSync('glab', args, {
    encoding: 'buffer',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.error) throw new Error(`glab error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.toString('utf8') ?? '',
    status: result.status,
  };
}

export function glabApi(endpoint: string, host?: string): GlabResult {
  const args = ['api', ...hostnameArgs(host), endpoint];
  verbose(`gitlab: glab fallback: glab ${args.join(' ')}`);
  const res = glabRun(args);
  if (res.status === 0) verbose(`  -> glab ok`);
  else verbose(`  -> glab failed (exit ${res.status})`);
  return res;
}

export function glabApiBinary(
  endpoint: string,
  host?: string,
): GlabBinaryResult {
  const args = ['api', ...hostnameArgs(host), endpoint];
  verbose(`gitlab: glab fallback: glab ${args.join(' ')}`);
  const res = glabRunBinary(args);
  if (res.status === 0) verbose(`  -> glab ok (${res.stdout.length} bytes)`);
  else verbose(`  -> glab failed (exit ${res.status})`);
  return res;
}

/** stderr (trimmed) of a failed glab call, or a generic exit-status message. */
export function glabFailure(res: GlabResult): string {
  return res.stderr.trim() || 'glab exited with status ' + res.status;
}

/**
 * Fetches the first tag of a project (ordered by `orderBy`, descending) via
 * glab. Throws `${failPrefix}: <stderr>` when glab fails and `emptyMessage`
 * when the project has no tags.
 */
export function firstTagViaCli(
  project: string,
  host: string | undefined,
  orderBy: 'updated' | 'version',
  failPrefix: string,
  emptyMessage: string,
): string {
  const endpoint = projectEndpoint(
    project,
    `repository/tags?order_by=${orderBy}&sort=desc&per_page=1`,
  );
  const res = glabApi(endpoint, host);
  if (res.status !== 0) throw new Error(`${failPrefix}: ${res.stderr}`);
  if (!res.stdout.trim()) throw new Error(emptyMessage);
  const tags = JSON.parse(res.stdout) as Array<{ name: string }>;
  if (!tags.length) throw new Error(emptyMessage);
  return tags[0].name;
}
