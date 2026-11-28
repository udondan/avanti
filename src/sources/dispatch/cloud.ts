import { resolveVars } from '../../variables';
import { fetchS3 } from '../s3';
import { fetchSecretsManager } from '../secrets-manager';
import { fetchSsm } from '../ssm';
import { fetchVault } from '../vault';
import {
  filterOf,
  prefixIfDefined,
  prefixIfSet,
  prefixResolvedIfDefined,
  prefixResolvedIfSet,
  resolveNonEmpty,
  resolveOptional,
  shaOf,
} from './helpers';
import { DescriptorMap } from './types';

/** Descriptors for AWS (S3, Secrets Manager, SSM) and Vault sources. */
export const CLOUD_DESCRIPTORS: DescriptorMap<
  'aws_s3' | 'aws_secrets_manager' | 'aws_systems_manager_parameter' | 'vault'
> = {
  aws_s3: {
    filename: (src) => src.aws_s3,
    label: (src) => `aws_s3:${src.aws_s3}`,
    cacheKey: (src, vars) => `aws_s3:${resolveVars(src.aws_s3, vars)}`,
    expectedSha: shaOf,
    filter: filterOf,
    fetch: async (src, { vars }) => {
      const result = await fetchS3(resolveVars(src.aws_s3, vars));
      return { files: result.files };
    },
  },
  aws_secrets_manager: {
    filename: ({ aws_secrets_manager: sm }) =>
      sm.name.split(/[:/]/).filter(Boolean).pop() ?? null,
    label: ({ aws_secrets_manager: sm }) =>
      `aws_secrets_manager:${sm.name}${prefixIfDefined('#', sm.key)}${prefixIfDefined('@', sm.region)}`,
    cacheKey: ({ aws_secrets_manager: sm }, vars) => {
      const k = prefixResolvedIfDefined('#', sm.key, vars);
      const r = prefixResolvedIfDefined('@', sm.region, vars);
      return `aws_secrets_manager:${resolveVars(sm.name, vars)}${k}${r}`;
    },
    expectedSha: (src) => src.aws_secrets_manager.sha,
    fetch: async ({ aws_secrets_manager: sm }, { vars }) => {
      const result = await fetchSecretsManager(
        resolveVars(sm.name, vars),
        resolveNonEmpty(sm.key, vars),
        resolveNonEmpty(sm.region, vars),
      );
      return { files: result.files };
    },
  },
  aws_systems_manager_parameter: {
    filename: (src) => src.aws_systems_manager_parameter.name,
    label: ({ aws_systems_manager_parameter: p }) =>
      `aws_systems_manager_parameter:${p.name}${prefixIfDefined('@', p.region)}`,
    cacheKey: ({ aws_systems_manager_parameter: p }, vars) => {
      const r = prefixResolvedIfDefined('@', p.region, vars);
      return `aws_systems_manager_parameter:${resolveVars(p.name, vars)}${r}`;
    },
    expectedSha: (src) => src.aws_systems_manager_parameter.sha,
    fetch: async ({ aws_systems_manager_parameter: p }, { vars }) => {
      const result = await fetchSsm(
        resolveVars(p.name, vars),
        resolveNonEmpty(p.region, vars),
      );
      return { files: result.files };
    },
  },
  vault: {
    label: (src) =>
      `vault:${src.vault.path}${prefixIfSet('#', src.vault.field)}`,
    cacheKey: ({ vault }, vars) => {
      const field = prefixResolvedIfSet('#', vault.field, vars);
      return `vault:${resolveVars(vault.path, vars)}${field}`;
    },
    expectedSha: (src) => src.vault.sha,
    fetch: async ({ vault }, { vars }) => {
      const result = await fetchVault(
        resolveVars(vault.path, vars),
        resolveOptional(vault.field, vars),
      );
      return { files: result.files };
    },
  },
};
