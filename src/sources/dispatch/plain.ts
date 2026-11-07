import { Variables } from '../../types';
import { resolveVars } from '../../variables';
import {
  parseGitHubSpec,
  parseGitLabSpec,
  resolveRelativeSrc,
} from '../../config';
import { fetchHttp } from '../http';
import { fetchLocal } from '../local';
import { fetchGitLab } from '../gitlab';
import { fetchGitHub } from '../github';
import { fetchGit, isGitRemoteUrl, parseGitRemoteSpec } from '../git';
import {
  downloadFiles,
  gitRemoteFile,
  isHttpUrl,
  urlPathname,
} from './helpers';
import { FetchContext, RawFetchResult } from './types';

// Plain-string sources: an http(s) URL, a git remote URL, a github:/gitlab:
// shorthand spec, or a local path.

export function plainSrcFilename(src: string): string {
  if (isHttpUrl(src)) return urlPathname(src);
  if (isGitRemoteUrl(src)) return gitRemoteFile(src);
  return src;
}

function isRemoteUrl(s: string): boolean {
  return isHttpUrl(s) || isGitRemoteUrl(s);
}

function isForgeShorthand(s: string): boolean {
  return s.startsWith('github:') || s.startsWith('gitlab:');
}

function resolvePlainSrc(
  src: string,
  vars: Variables,
  configBase: string | undefined,
): string {
  const resolved = resolveVars(src, vars);
  return configBase !== undefined
    ? resolveRelativeSrc(resolved, configBase)
    : resolved;
}

function parseShorthand<T>(
  parse: (spec: string) => T,
  spec: string,
  kind: string,
  expected: string,
): T {
  try {
    return parse(spec);
  } catch {
    throw new Error(
      `Invalid ${kind} source spec "${spec}". Expected: ${expected}`,
    );
  }
}

async function fetchShorthand(effective: string): Promise<RawFetchResult> {
  if (effective.startsWith('github:')) {
    const parsed = parseShorthand(
      parseGitHubSpec,
      effective,
      'github',
      'github:owner/repo:path/to/file[@ref]',
    );
    const result = await fetchGitHub(parsed.repo, parsed.file, parsed.ref);
    return { files: result.files };
  }
  const parsed = parseShorthand(
    parseGitLabSpec,
    effective,
    'gitlab',
    'gitlab:group/project:path/to/file[@ref]',
  );
  const result = await fetchGitLab(parsed.project, parsed.file, parsed.ref);
  return { files: result.files };
}

export async function fetchPlainSrc(
  src: string,
  { workingDir, vars, configBase }: FetchContext,
): Promise<RawFetchResult> {
  const effective = resolvePlainSrc(src, vars, configBase);
  if (isHttpUrl(effective)) {
    const content = await fetchHttp(effective);
    return { files: downloadFiles(effective, content) };
  }
  if (isGitRemoteUrl(effective)) {
    const { repo, file, ref } = parseGitRemoteSpec(effective);
    return { files: fetchGit(repo, file, ref).files };
  }
  if (isForgeShorthand(effective)) return fetchShorthand(effective);
  return { files: fetchLocal(effective, workingDir).files };
}

/**
 * Local path a plain-string source refers to, or `undefined` when the source
 * is remote (URL, git remote or github:/gitlab: shorthand).
 */
export function plainLocalPath(
  src: string,
  vars: Variables,
  configBase: string | undefined,
): string | undefined {
  const resolved = resolveVars(src, vars);
  // Remote URLs are never resolved against the config directory.
  const effective =
    configBase === undefined || isRemoteUrl(resolved)
      ? resolved
      : resolveRelativeSrc(resolved, configBase);
  return [effective].find((p) => !isRemoteUrl(p) && !isForgeShorthand(p));
}
