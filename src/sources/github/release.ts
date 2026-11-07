import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from '../../fetch';
import { compilePatterns, expandBraces, matchesAnyPattern } from '../../filter';
import { verbose } from '../../logger';
import type { Via } from '../../types';
import { apiOrCli, normalizeVia, withTransports } from '../forge/transport';
import {
  apiGet,
  apiHeaders,
  getApiBase,
  GH,
  ghRun,
  type GitHubResult,
  githubHttpError,
  hostnameArgs,
} from './client';
import { resolveRef } from './ref';

interface GitHubAsset {
  id: number;
  name: string;
}

async function downloadAsset(
  repo: string,
  tag: string,
  asset: GitHubAsset,
  host?: string,
): Promise<[string, Buffer]> {
  const dlRes = await fetchWithRetry(
    `${getApiBase(host)}/repos/${repo}/releases/assets/${asset.id}`,
    {
      headers: { ...apiHeaders(), Accept: 'application/octet-stream' },
      redirect: 'follow',
    },
  );
  if (!dlRes.ok) {
    throw await githubHttpError(
      dlRes,
      `Failed to download release asset "${asset.name}" from ${repo}@${tag}`,
    );
  }
  return [path.basename(asset.name), Buffer.from(await dlRes.arrayBuffer())];
}

async function fetchReleaseAssetsViaApi(
  repo: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Promise<Map<string, Buffer>> {
  const res = await apiGet(
    host,
    `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (!res.ok) {
    throw await githubHttpError(
      res,
      `Failed to fetch release ${tag} from ${repo}`,
    );
  }
  const rel = (await res.json()) as { assets: GitHubAsset[] };
  if (!rel.assets.length) {
    throw new Error(`No release assets found for ${repo}@${tag}`);
  }
  let assets = rel.assets;
  if (preFilter && preFilter.length > 0) {
    const compiled = compilePatterns(preFilter);
    assets = assets.filter((a) =>
      matchesAnyPattern(path.basename(a.name), compiled),
    );
    if (assets.length === 0) return new Map();
  }
  const entries = await Promise.all(
    assets.map((asset) => downloadAsset(repo, tag, asset, host)),
  );
  return new Map(entries);
}

function isRegexFilter(p: string): boolean {
  return p.length > 2 && p.startsWith('/') && p.endsWith('/');
}

// Pass each filter pattern as --pattern so gh only fetches matching
// assets. gh's --pattern is glob-only: regex patterns (/pat/) and brace
// expansions ({a,b}) are not understood. Detect any regex pattern and fall
// back to downloading all assets (the compiled filter below handles
// correctness). For non-regex filters, expand braces first and pass each
// resulting glob as a separate --pattern arg.
function patternArgs(preFilter?: string[]): string[] {
  if (!preFilter?.length || preFilter.some(isRegexFilter)) return [];
  return preFilter
    .flatMap((p) =>
      p.includes('{') && !p.endsWith('/') ? expandBraces(p) : [p],
    )
    .flatMap((p) => ['--pattern', p]);
}

function readDownloadedAssets(
  dir: string,
  preFilter?: string[],
): Map<string, Buffer> {
  const compiled =
    preFilter && preFilter.length > 0 ? compilePatterns(preFilter) : undefined;
  const files = new Map<string, Buffer>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (compiled && !matchesAnyPattern(entry.name, compiled)) continue;
    files.set(entry.name, fs.readFileSync(path.join(dir, entry.name)));
  }
  return files;
}

function fetchReleaseAssetsViaCli(
  repo: string,
  tag: string,
  host?: string,
  preFilter?: string[],
): Map<string, Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-gh-rel-'));
  try {
    const args = [
      'release',
      'download',
      tag,
      '--repo',
      repo,
      '--dir',
      tmpDir,
      ...hostnameArgs(host),
      ...patternArgs(preFilter),
    ];
    verbose(`github: gh release download: gh ${args.join(' ')}`);
    const result = ghRun(args);
    if (result.status !== 0) {
      throw new Error(
        `Failed to download release ${tag} from ${repo}: ${result.stderr}`,
      );
    }
    const files = readDownloadedAssets(tmpDir, preFilter);
    if (!files.size && !preFilter?.length) {
      throw new Error(`No release assets found for ${repo}@${tag}`);
    }
    return files;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function fetchGitHubRelease(
  repo: string,
  release: string,
  host?: string,
  via?: Via | Via[],
  preFilter?: string[],
): Promise<GitHubResult> {
  const transports = normalizeVia(via);
  const tag = await resolveRef(repo, release, host, transports);
  verbose(`github: fetching release assets for ${repo}@${tag}`);

  const viaCli = () => ({
    files: fetchReleaseAssetsViaCli(repo, tag, host, preFilter),
  });
  return withTransports(transports, viaCli, (withCliFallback) =>
    apiOrCli(
      GH,
      withCliFallback,
      async () => ({
        files: await fetchReleaseAssetsViaApi(repo, tag, host, preFilter),
      }),
      viaCli,
    ),
  );
}
