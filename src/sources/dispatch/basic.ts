import { Variables } from '../../types';
import { resolveVars, resolveVarsShellSafe } from '../../variables';
import { isRemoteConfigSpec, resolveRelativeSrc } from '../../config';
import { fetchHttp } from '../http';
import { fetchLocal } from '../local';
import { fetchExec } from '../exec';
import { fetchGit, isGitRemoteUrl, parseGitRemoteSpec } from '../git';
import {
  downloadFiles,
  filterOf,
  gitRemoteFile,
  shaOf,
  urlPathname,
} from './helpers';
import { DescriptorMap, RawFetchResult } from './types';

function skipped(): RawFetchResult {
  return { files: new Map(), skipped: true };
}

/**
 * Resolves a `path:` source. Relative paths resolve against the config
 * directory unless the config itself is remote.
 */
export function resolveLocalPathSrc(
  srcPath: string,
  vars: Variables,
  configBase: string | undefined,
): string {
  const resolved = resolveVars(srcPath, vars);
  return configBase !== undefined && !isRemoteConfigSpec(configBase)
    ? resolveRelativeSrc(resolved, configBase)
    : resolved;
}

function fetchOptionalGit(
  spec: string,
  optional: boolean | undefined,
): RawFetchResult {
  const { repo, file, ref } = parseGitRemoteSpec(spec);
  try {
    return { files: fetchGit(repo, file, ref).files };
  } catch (err) {
    if (optional) return skipped();
    throw err;
  }
}

/** Descriptors for raw, local path, URL, HTTP and exec sources. */
export const BASIC_DESCRIPTORS: DescriptorMap<
  'raw' | 'path' | 'url' | 'http' | 'exec'
> = {
  raw: {
    label: () => 'raw',
    // raw: key includes the resolved content so distinct raw values don't collide
    cacheKey: (src, vars) => `raw:${resolveVars(src.raw, vars)}`,
    fetch: (src, { vars }) => ({
      files: new Map([
        ['output', Buffer.from(resolveVars(src.raw, vars), 'utf8')],
      ]),
    }),
  },
  path: {
    filename: (src) => src.path,
    label: (src) => `path:${src.path}`,
    cacheKey: (src, vars) => `path:${resolveVars(src.path, vars)}`,
    expectedSha: shaOf,
    filter: filterOf,
    fetch: (src, { workingDir, vars, configBase }) => {
      const effective = resolveLocalPathSrc(src.path, vars, configBase);
      const result = fetchLocal(effective, workingDir, src.optional ?? false);
      if (result.missing) return skipped();
      return { files: result.files };
    },
  },
  url: {
    filename: (src) =>
      isGitRemoteUrl(src.url) ? gitRemoteFile(src.url) : urlPathname(src.url),
    label: (src) => `url:${src.url}`,
    cacheKey: (src, vars) => `url:${resolveVars(src.url, vars)}`,
    expectedSha: shaOf,
    fetch: async (src, { vars }) => {
      const resolved = resolveVars(src.url, vars);
      if (isGitRemoteUrl(resolved)) {
        return fetchOptionalGit(resolved, src.optional);
      }
      const content = await fetchHttp(resolved, src.optional ?? false);
      if (content === null) return skipped();
      return { files: downloadFiles(resolved, content) };
    },
  },
  http: {
    filename: (src) => urlPathname(src.http),
    label: (src) => `http:${src.http}`,
    cacheKey: (src, vars) => `http:${resolveVars(src.http, vars)}`,
    expectedSha: shaOf,
    fetch: async (src, { vars }) => {
      const resolvedUrl = resolveVars(src.http, vars);
      const content = await fetchHttp(resolvedUrl);
      return { files: downloadFiles(resolvedUrl, content) };
    },
  },
  exec: {
    label: (src) => `exec:${src.exec}`,
    cacheKey: (src, vars) => `exec:${resolveVars(src.exec, vars)}`,
    expectedSha: shaOf,
    fetch: (src, { vars }) => ({
      files: new Map([
        ['output', fetchExec(resolveVarsShellSafe(src.exec, vars))],
      ]),
    }),
  },
};
