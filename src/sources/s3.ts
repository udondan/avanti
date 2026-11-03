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

function parseS3Uri(
  uri: string,
  isDir: boolean,
): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  const key = match[2];
  if (!isDir && !key) throw new Error(`S3 object key is required: ${uri}`);
  return { bucket: match[1], key };
}

export async function fetchS3(uri: string): Promise<S3Result> {
  const client = new S3Client({});
  try {
    const isDir = uri.endsWith('/');
    const { bucket, key } = parseS3Uri(uri, isDir);

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
    let isTruncated = false;

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: key,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = (response.Contents ?? []).filter(
        (obj) => obj.Key && !obj.Key.endsWith('/'),
      );

      const BATCH = 50;
      for (let i = 0; i < objects.length; i += BATCH) {
        await Promise.all(
          objects.slice(i, i + BATCH).map(async (obj) => {
            const objKey = obj.Key!;
            if (isVerbose())
              verbose(`s3 GetObject ${redactUrl(`s3://${bucket}/${objKey}`)}`);
            const get = await client.send(
              new GetObjectCommand({ Bucket: bucket, Key: objKey }),
            );
            if (!get.Body)
              throw new Error(`No body returned for s3://${bucket}/${objKey}`);
            const bytes = await get.Body.transformToByteArray();
            const relKey = objKey.slice(key.length).replace(/^\/+/, '');
            files.set(relKey, Buffer.from(bytes));
          }),
        );
      }

      isTruncated = response.IsTruncated ?? false;
      continuationToken = response.NextContinuationToken;
    } while (isTruncated);

    return { files };
  } finally {
    client.destroy();
  }
}
