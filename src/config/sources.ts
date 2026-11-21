/** Dispatches `src:` values to the parser for their source type. */
import { FileSrc } from '../types';
import {
  parseAwsS3Src,
  parseExecSrc,
  parseHttpSrc,
  parsePathSrc,
  parseRawSrc,
  parseUrlSrc,
} from './sources-plain';
import {
  parseBitbucketSrc,
  parseGitHubSrc,
  parseGitLabSrc,
  parseGitSrc,
} from './sources-forge';
import {
  parseAwsSecretsManagerSrc,
  parseAwsSsmSrc,
  parseVaultSrc,
} from './sources-secrets';
import { isPlainObject } from './validate';

type SrcParser = (obj: Record<string, unknown>, loc: string) => FileSrc;

// Checked in this order; the first key present on the object selects the parser.
const SRC_PARSERS: ReadonlyArray<[string, SrcParser]> = [
  ['path', parsePathSrc],
  ['url', parseUrlSrc],
  ['http', parseHttpSrc],
  ['exec', parseExecSrc],
  ['gitlab', parseGitLabSrc],
  ['raw', parseRawSrc],
  ['github', parseGitHubSrc],
  ['bitbucket', parseBitbucketSrc],
  ['git', parseGitSrc],
  ['aws_s3', parseAwsS3Src],
  ['vault', parseVaultSrc],
  ['aws_secrets_manager', parseAwsSecretsManagerSrc],
  ['aws_systems_manager_parameter', parseAwsSsmSrc],
];

function parseSingleSrc(raw: unknown, loc: string): FileSrc {
  // Plain string → http/https URL or local path
  if (typeof raw === 'string') {
    return raw;
  }

  if (!isPlainObject(raw)) {
    throw new Error(
      `${loc}: must be a string or a map with one of: path, url, exec, gitlab, github, bitbucket, git, aws_s3, vault, http, raw, aws_secrets_manager, aws_systems_manager_parameter`,
    );
  }

  const match = SRC_PARSERS.find(([key]) => key in raw);
  if (match) return match[1](raw, loc);

  throw new Error(
    `${loc}: unknown source type. Must be a string or map with exec/gitlab/github/bitbucket/git/aws_s3/vault/http/url/path/raw/aws_secrets_manager/aws_systems_manager_parameter`,
  );
}

/** Parses a `src:` field that is either a single source or a list of sources. */
export function parseSrcField(raw: unknown, loc: string): FileSrc | FileSrc[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).map((item, j) =>
        parseSingleSrc(item, `${loc}.src[${j}]`),
      )
    : parseSingleSrc(raw, `${loc}.src`);
}
