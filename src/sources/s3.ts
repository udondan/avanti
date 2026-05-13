import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import * as path from 'path';
import { verbose, isVerbose } from '../logger';
import { redactUrl } from '../fetch';

export interface S3Result {
  files: Map<string, Buffer>;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

export async function fetchS3(uri: string): Promise<S3Result> {
  const client = new S3Client({});
  const { bucket, key } = parseS3Uri(uri);
  const isDir = uri.endsWith('/');

  if (!isDir) {
    if (isVerbose()) verbose(`s3 GetObject ${redactUrl(uri)}`);
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`No body returned for ${uri}`);
    const bytes = await response.Body.transformToByteArray();
    const buf = Buffer.from(bytes);
    const filename = path.basename(key) || 'download';
    return { files: new Map([[filename, buf]]) };
  }

  if (isVerbose()) verbose(`s3 ListObjectsV2 ${redactUrl(uri)}`);
  const files = new Map<string, Buffer>();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: key,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;
      if (isVerbose()) verbose(`s3 GetObject s3://${bucket}/${obj.Key}`);
      const get = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
      );
      if (!get.Body) continue;
      const bytes = await get.Body.transformToByteArray();
      const buf = Buffer.from(bytes);
      const relKey = obj.Key.slice(key.length);
      files.set(relKey, buf);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return { files };
}
