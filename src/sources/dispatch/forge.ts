import { GitHubSrc, GitLabSrc, Variables, Via } from '../../types';
import { resolveVars } from '../../variables';
import { fetchGitLab, fetchGitLabRelease } from '../gitlab';
import { fetchGitHub, fetchGitHubRelease } from '../github';
import { fetchBitbucket } from '../bitbucket';
import { fetchGit } from '../git';
import {
  filterOf,
  hostTag,
  prefixIfSet,
  prefixResolvedIfSet,
  resolvedHostTag,
  resolveOptional,
} from './helpers';
import {
  DescriptorMap,
  FetchContext,
  RawFetchResult,
  SourceDescriptor,
} from './types';

type ViaOption = Via | Via[] | undefined;

interface ForgeCommon {
  host?: string;
  via?: ViaOption;
  sha?: string;
}

/** The inner `github:` / `gitlab:` map: either a file or a release spec. */
type ForgeSpec =
  | (ForgeCommon & { file: string; ref?: string })
  | (ForgeCommon & { release: string });

type ForgeFetch = Promise<{ files: Map<string, Buffer> }>;

interface ForgeAccess<S> {
  name: 'github' | 'gitlab';
  spec(src: S): ForgeSpec;
  /** Repository (github) or project (gitlab) path. */
  target(src: S): string;
  fetchFile(
    target: string,
    file: string,
    ref: string | undefined,
    host: string | undefined,
    via: ViaOption,
  ): ForgeFetch;
  fetchRelease(
    target: string,
    release: string,
    host: string | undefined,
    via: ViaOption,
    preFilter: string[] | undefined,
  ): ForgeFetch;
}

function viaTag(via: ViaOption): string {
  const viaStr = Array.isArray(via) ? via.join(',') : (via ?? 'api,cli');
  return viaStr === 'api,cli' ? '' : `(${viaStr})`;
}

// Include the filter in the cache key for release sources: the fetch is
// pre-filtered before caching, so two entries with different filters on the
// same release must not share a cache slot.
function releaseFilterTag(
  filter: string[] | undefined,
  vars: Variables,
): string {
  if (!filter || filter.length === 0) return '';
  return `\x00filter:${JSON.stringify(filter.map((p) => resolveVars(p, vars)))}`;
}

function forgeLabel(name: string, target: string, spec: ForgeSpec): string {
  const host = hostTag(spec.host);
  if ('release' in spec) {
    return `${name}${host}:${target}:release:${spec.release}`;
  }
  return `${name}${host}:${target}:${spec.file}${prefixIfSet('@', spec.ref)}`;
}

function forgeCacheKey<S extends { filter?: string[] }>(
  access: ForgeAccess<S>,
  src: S,
  vars: Variables,
): string {
  const spec = access.spec(src);
  const host = resolvedHostTag(spec.host, vars);
  const via = viaTag(spec.via);
  const prefix = `${access.name}${host}`;
  if ('release' in spec) {
    const target = resolveVars(access.target(src), vars);
    const release = resolveVars(spec.release, vars);
    return `${prefix}:${target}:release:${release}${via}${releaseFilterTag(src.filter, vars)}`;
  }
  const ref = prefixResolvedIfSet('@', spec.ref, vars);
  const target = resolveVars(access.target(src), vars);
  return `${prefix}:${target}:${resolveVars(spec.file, vars)}${ref}${via}`;
}

async function fetchForge<S extends { filter?: string[] }>(
  access: ForgeAccess<S>,
  src: S,
  { vars }: FetchContext,
): Promise<RawFetchResult> {
  const spec = access.spec(src);
  const host = resolveOptional(spec.host, vars);
  if ('release' in spec) {
    const preFilter = src.filter?.map((p) => resolveVars(p, vars));
    const result = await access.fetchRelease(
      resolveVars(access.target(src), vars),
      resolveVars(spec.release, vars),
      host,
      spec.via,
      preFilter,
    );
    return { files: result.files };
  }
  const result = await access.fetchFile(
    resolveVars(access.target(src), vars),
    resolveVars(spec.file, vars),
    resolveOptional(spec.ref, vars),
    host,
    spec.via,
  );
  return { files: result.files };
}

function forgeDescriptor<S extends { filter?: string[] }>(
  access: ForgeAccess<S>,
): SourceDescriptor<S> {
  return {
    filename: (src) => {
      const spec = access.spec(src);
      return 'file' in spec ? spec.file : null;
    },
    label: (src) =>
      forgeLabel(access.name, access.target(src), access.spec(src)),
    cacheKey: (src, vars) => forgeCacheKey(access, src, vars),
    expectedSha: (src) => access.spec(src).sha,
    filter: filterOf,
    fetch: (src, ctx) => fetchForge(access, src, ctx),
  };
}

/** Descriptors for GitHub, GitLab, Bitbucket and generic git sources. */
export const FORGE_DESCRIPTORS: DescriptorMap<
  'github' | 'gitlab' | 'bitbucket' | 'git'
> = {
  github: forgeDescriptor<GitHubSrc>({
    name: 'github',
    spec: (src) => src.github,
    target: (src) => src.github.repo,
    fetchFile: (repo, file, ref, host, via) =>
      fetchGitHub(repo, file, ref, host, via),
    fetchRelease: (repo, release, host, via, preFilter) =>
      fetchGitHubRelease(repo, release, host, via, preFilter),
  }),
  gitlab: forgeDescriptor<GitLabSrc>({
    name: 'gitlab',
    spec: (src) => src.gitlab,
    target: (src) => src.gitlab.project,
    fetchFile: (project, file, ref, host, via) =>
      fetchGitLab(project, file, ref, host, via),
    fetchRelease: (project, release, host, via, preFilter) =>
      fetchGitLabRelease(project, release, host, via, preFilter),
  }),
  bitbucket: {
    filename: (src) => src.bitbucket.file,
    label: ({ bitbucket: b }) =>
      `bitbucket${hostTag(b.host)}:${b.workspace}/${b.repo}:${b.file}${prefixIfSet('@', b.ref)}`,
    cacheKey: ({ bitbucket: b }, vars) => {
      const ref = prefixResolvedIfSet('@', b.ref, vars);
      const host = resolvedHostTag(b.host, vars);
      return `bitbucket${host}:${resolveVars(b.workspace, vars)}/${resolveVars(b.repo, vars)}:${resolveVars(b.file, vars)}${ref}`;
    },
    expectedSha: (src) => src.bitbucket.sha,
    filter: filterOf,
    fetch: async ({ bitbucket: b }, { vars }) => {
      const result = await fetchBitbucket(
        resolveVars(b.workspace, vars),
        resolveVars(b.repo, vars),
        resolveVars(b.file, vars),
        resolveOptional(b.ref, vars),
        resolveOptional(b.host, vars),
      );
      return { files: result.files };
    },
  },
  git: {
    filename: (src) => src.git.file,
    label: ({ git }) =>
      `git:${git.repo}:${git.file}${prefixIfSet('@', git.ref)}`,
    cacheKey: ({ git }, vars) => {
      const ref = prefixResolvedIfSet('@', git.ref, vars);
      return `git:${resolveVars(git.repo, vars)}:${resolveVars(git.file, vars)}${ref}`;
    },
    expectedSha: (src) => src.git.sha,
    filter: filterOf,
    fetch: ({ git }, { vars }) => ({
      files: fetchGit(
        resolveVars(git.repo, vars),
        resolveVars(git.file, vars),
        resolveOptional(git.ref, vars),
      ).files,
    }),
  },
};
