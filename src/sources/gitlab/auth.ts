import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { verbose } from '../../logger';
import { firstNonEmpty } from '../forge/transport';
import { envToken, hostnameArgs } from './client';

const TOKEN_FOUND = /Token found:\s*(\S+)/;

function isHostHeader(header: string, normalizedHost: string): boolean {
  return [normalizedHost, 'ssh.' + normalizedHost].some(
    (h) => header === h || header.startsWith(h + ' '),
  );
}

function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t');
}

// Extracts the token from `glab auth status --show-token` output for a specific
// host. The output is grouped by instance (one section per configured host);
// host headers appear at column 0 (no leading whitespace) while details are
// indented. We find the section for targetHost (matching the bare name or the
// ssh.* variant that glab may store internally) and return the "Token found:"
// value from within that section only, avoiding wrong-instance token selection
// in multi-instance configs where the first regex match could be for a
// different host that appears earlier in the output.
function tokenForHost(output: string, targetHost: string): string | undefined {
  const normalized = targetHost.toLowerCase().replace(/^ssh\./, '');
  let inSection = false;
  for (const line of output.split('\n')) {
    // Host headers start at column 0 (not indented)
    if (line.length > 0 && !isIndented(line)) {
      inSection = isHostHeader(line.trim().toLowerCase(), normalized);
    }
    const m = inSection ? TOKEN_FOUND.exec(line) : null;
    if (m) return m[1];
  }
  return undefined;
}

function combinedOutput(res: SpawnSyncReturns<string>): string {
  return (res.stdout ?? '') + (res.stderr ?? '');
}

// For the scoped attempt (--hostname): only accept the token when glab exits 0
// to avoid using a stale token that glab still prints in the error output while
// indicating the credential is invalid.
function scopedToken(host?: string): string | undefined {
  const res = spawnSync(
    'glab',
    ['auth', 'status', '--show-token', ...hostnameArgs(host)],
    { encoding: 'utf8' },
  );
  const output = combinedOutput(res);
  return res.status === 0 ? TOKEN_FOUND.exec(output)?.[1] : undefined;
}

// Fallback without --hostname in case glab uses a different key for this
// instance (e.g. ssh.git.example.com vs git.example.com). Use --all to
// enumerate every configured instance regardless of the current git context,
// then tokenForHost() picks the right section. Unset GITLAB_HOST so glab
// doesn't re-apply the env-override we already tried with --hostname, and
// extract the token from the specific host section so we never return a
// different instance's token in multi-instance configs.
function allInstancesToken(configuredHost: string): string | undefined {
  const env = { ...process.env };
  delete env['GITLAB_HOST'];
  const res = spawnSync('glab', ['auth', 'status', '--show-token', '--all'], {
    encoding: 'utf8',
    env,
  });
  return tokenForHost(combinedOutput(res), configuredHost);
}

// Returns the best available auth token: env var first, then glab's stored
// credentials via `glab auth status --show-token`.
// glab may store the instance under a different hostname key (e.g.
// ssh.hostname when the avanti config uses hostname), so we try with
// --hostname first and fall back to no --hostname to get any available token.
// Output may be on stdout or stderr depending on glab version, so we check
// both streams.
export function resolveToken(host?: string): string | undefined {
  const token = envToken();
  if (token) return token;
  const scoped = scopedToken(host);
  if (scoped) {
    verbose(`gitlab: resolved auth token via glab auth status`);
    return scoped;
  }
  const configuredHost = firstNonEmpty(host, process.env.GITLAB_HOST);
  if (!configuredHost) return undefined;
  const fallback = allInstancesToken(configuredHost);
  if (fallback) {
    verbose(
      `gitlab: resolved auth token via glab auth status (no --hostname, host verified)`,
    );
  }
  return fallback;
}
