/** Parsers for secret-store source types: vault, AWS Secrets Manager, AWS SSM. */
import { AwsSecretsManagerSrc, AwsSsmSrc, VaultSrc } from '../types';
import { parseConditionField } from './conditions';
import {
  optionalNonEmptyString,
  optionalString,
  parseSha,
  requireObjectField,
  requireStringField,
} from './validate';

type SrcObject = Record<string, unknown>;

/** Returns the nested source object and its validated required string field. */
function requireNested(
  obj: SrcObject,
  kind: string,
  field: string,
  loc: string,
): [Record<string, unknown>, string] {
  const nested = requireObjectField(obj, kind, loc);
  return [nested, requireStringField(nested, field, `${loc}.${kind}`)];
}

export function parseVaultSrc(obj: SrcObject, loc: string): VaultSrc {
  const [vt, path] = requireNested(obj, 'vault', 'path', loc);
  const vaultConds = parseConditionField(obj, loc);
  return {
    vault: {
      path,
      field: optionalString(vt['field']),
      sha: parseSha(vt['sha'], `${loc}.vault`),
    },
    ...vaultConds,
  };
}

export function parseAwsSecretsManagerSrc(
  obj: SrcObject,
  loc: string,
): AwsSecretsManagerSrc {
  const [smt, name] = requireNested(obj, 'aws_secrets_manager', 'name', loc);
  const smConds = parseConditionField(obj, loc);
  return {
    aws_secrets_manager: {
      name,
      key: optionalNonEmptyString(smt['key']),
      region: optionalNonEmptyString(smt['region']),
      sha: parseSha(smt['sha'], `${loc}.aws_secrets_manager`),
    },
    ...smConds,
  };
}

export function parseAwsSsmSrc(obj: SrcObject, loc: string): AwsSsmSrc {
  const [ssmt, name] = requireNested(
    obj,
    'aws_systems_manager_parameter',
    'name',
    loc,
  );
  const ssmConds = parseConditionField(obj, loc);
  return {
    aws_systems_manager_parameter: {
      name,
      region: optionalNonEmptyString(ssmt['region']),
      sha: parseSha(ssmt['sha'], `${loc}.aws_systems_manager_parameter`),
    },
    ...ssmConds,
  };
}
