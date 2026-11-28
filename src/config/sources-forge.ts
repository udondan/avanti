/** Parsers for repository-hosted source types: gitlab, github, bitbucket, git. */
import { BitbucketSrc, GitHubSrc, GitLabSrc, GitSrc } from '../types';
import { parseConditionField } from './conditions';
import {
  assertOptionalHost,
  assertOptionalNonEmptyString,
  isNonEmptyString,
  optionalString,
  parseFilter,
  parseSha,
  parseVia,
  requireObjectField,
  requireStringField,
} from './validate';

type SrcObject = Record<string, unknown>;

function filterField(filter: string[] | undefined): { filter?: string[] } {
  return filter !== undefined ? { filter } : {};
}

/**
 * Validates the shared shape of `gitlab:` and `github:` sources and returns
 * whether the release form (as opposed to the file form) is used.
 */
function validateForgeTarget(
  g: Record<string, unknown>,
  where: string,
): boolean {
  assertOptionalNonEmptyString(g['file'], `${where}.file`);
  assertOptionalNonEmptyString(g['release'], `${where}.release`);
  const hasFile = isNonEmptyString(g['file']);
  const hasRelease = isNonEmptyString(g['release']);
  if (hasFile && hasRelease) {
    throw new Error(`${where}: "file" and "release" are mutually exclusive`);
  }
  if (!hasFile && !hasRelease) {
    throw new Error(`${where}: one of "file" or "release" is required`);
  }
  if (hasRelease && g['ref'] !== undefined) {
    throw new Error(`${where}: "ref" is not valid when using "release"`);
  }
  assertOptionalHost(g['host'], where);
  return hasRelease;
}

function parseForgeSrc(
  obj: SrcObject,
  loc: string,
  kind: 'gitlab' | 'github',
  idKey: 'project' | 'repo',
): Record<string, unknown> {
  const g = requireObjectField(obj, kind, loc);
  const where = `${loc}.${kind}`;
  const id = requireStringField(g, idKey, where);
  const hasRelease = validateForgeTarget(g, where);
  const conds = parseConditionField(obj, loc);
  const filter = parseFilter(obj, loc);
  const target = hasRelease
    ? { release: g['release'] as string }
    : { file: g['file'] as string, ref: optionalString(g['ref']) };
  return {
    [kind]: {
      [idKey]: id,
      ...target,
      sha: parseSha(g['sha'], where),
      host: optionalString(g['host']),
      via: parseVia(g['via'], where),
    },
    ...filterField(filter),
    ...conds,
  };
}

export function parseGitLabSrc(obj: SrcObject, loc: string): GitLabSrc {
  return parseForgeSrc(obj, loc, 'gitlab', 'project') as unknown as GitLabSrc;
}

export function parseGitHubSrc(obj: SrcObject, loc: string): GitHubSrc {
  return parseForgeSrc(obj, loc, 'github', 'repo') as unknown as GitHubSrc;
}

export function parseBitbucketSrc(obj: SrcObject, loc: string): BitbucketSrc {
  const b = requireObjectField(obj, 'bitbucket', loc);
  const where = `${loc}.bitbucket`;
  const workspace = requireStringField(b, 'workspace', where);
  const repo = requireStringField(b, 'repo', where);
  const file = requireStringField(b, 'file', where);
  assertOptionalHost(b['host'], where);
  const conds = parseConditionField(obj, loc);
  const filter = parseFilter(obj, loc);
  return {
    bitbucket: {
      workspace,
      repo,
      file,
      ref: optionalString(b['ref']),
      sha: parseSha(b['sha'], where),
      host: optionalString(b['host']),
    },
    ...filterField(filter),
    ...conds,
  };
}

export function parseGitSrc(obj: SrcObject, loc: string): GitSrc {
  const gt = requireObjectField(obj, 'git', loc);
  const where = `${loc}.git`;
  const repo = requireStringField(gt, 'repo', where);
  const file = requireStringField(gt, 'file', where);
  const conds = parseConditionField(obj, loc);
  const filter = parseFilter(obj, loc);
  return {
    git: {
      repo,
      file,
      ref: optionalString(gt['ref']),
      sha: parseSha(gt['sha'], where),
    },
    ...filterField(filter),
    ...conds,
  };
}
