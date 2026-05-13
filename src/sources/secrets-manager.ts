import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import * as path from 'path';
import { verbose, isVerbose } from '../logger';

export interface SecretsManagerResult {
  files: Map<string, Buffer>;
}

export async function fetchSecretsManager(
  name: string,
  key?: string,
  region?: string,
): Promise<SecretsManagerResult> {
  const client = new SecretsManagerClient(region ? { region } : {});
  try {
    if (isVerbose()) verbose(`secrets-manager GetSecretValue ${name}`);
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: name }),
    );

    const filename = path.basename(name) || 'secret';

    if (response.SecretBinary) {
      const buf = Buffer.from(response.SecretBinary);
      return { files: new Map([[filename, buf]]) };
    }

    if (response.SecretString === undefined) {
      throw new Error(`No secret value returned for ${name}`);
    }

    if (key !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.SecretString);
      } catch {
        throw new Error(
          `aws_secrets_manager: secret "${name}" is not valid JSON (required for key extraction)`,
        );
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !(key in (parsed as Record<string, unknown>))
      ) {
        throw new Error(
          `aws_secrets_manager: key "${key}" not found in secret "${name}"`,
        );
      }
      const val = String((parsed as Record<string, unknown>)[key]);
      return { files: new Map([[filename, Buffer.from(val, 'utf8')]]) };
    }

    return {
      files: new Map([[filename, Buffer.from(response.SecretString, 'utf8')]]),
    };
  } finally {
    client.destroy();
  }
}
