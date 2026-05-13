import {
  GetParameterCommand,
  GetParametersByPathCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import * as path from 'path';
import { verbose, isVerbose } from '../logger';

export interface SsmResult {
  files: Map<string, Buffer>;
}

export async function fetchSsm(
  name: string,
  region?: string,
): Promise<SsmResult> {
  const client = new SSMClient(region ? { region } : {});
  try {
    if (!name.endsWith('/')) {
      if (isVerbose()) verbose(`ssm GetParameter ${name}`);
      const response = await client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      const value = response.Parameter?.Value;
      if (value === undefined) {
        throw new Error(`No value returned for SSM parameter ${name}`);
      }
      const filename = path.basename(name) || 'parameter';
      return { files: new Map([[filename, Buffer.from(value, 'utf8')]]) };
    }

    if (isVerbose()) verbose(`ssm GetParametersByPath ${name}`);
    const files = new Map<string, Buffer>();
    let nextToken: string | undefined;

    do {
      const response = await client.send(
        new GetParametersByPathCommand({
          Path: name,
          Recursive: true,
          WithDecryption: true,
          NextToken: nextToken,
        }),
      );

      for (const param of response.Parameters ?? []) {
        if (!param.Name || param.Value === undefined) continue;
        const relKey = param.Name.slice(name.length).replace(/^\/+/, '');
        files.set(
          relKey || path.basename(param.Name),
          Buffer.from(param.Value, 'utf8'),
        );
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return { files };
  } finally {
    client.destroy();
  }
}
