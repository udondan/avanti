import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import * as path from 'path';
import { verbose, isVerbose } from '../logger';
import { redactUrl } from '../fetch';

interface S3Result {
  files: Map<string, Buffer>;
}

function parseS3Uri(
  uri: string,
  isDir: boolean,
): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  const key = match[2];
  if (!isDir && !key) throw new Error(`S3 object key is required: ${uri}`);
  return { bucket: match[1], key };
}

// Downloads one object; `label` is the URI used in log and error output.
async function getObjectBytes(
  client: S3Client,
  bucket: string,
  key: string,
  label: string,
): Promise<Buffer> {
  if (isVerbose()) verbose(`s3 GetObject ${redactUrl(label)}`);
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`No body returned for ${label}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function fetchS3Object(
  client: S3Client,
  bucket: string,
  key: string,
  uri: string,
): Promise<S3Result> {
  const buf = await getObjectBytes(client, bucket, key, uri);
  const filename = path.basename(key) || 'download';
  return { files: new Map([[filename, buf]]) };
}

async function fetchS3Prefix(
  client: S3Client,
  bucket: string,
  key: string,
  uri: string,
): Promise<S3Result> {
  if (isVerbose()) verbose(`s3 ListObjectsV2 ${redactUrl(uri)}`);
  const files = new Map<string, Buffer>();
  let continuationToken: string | undefined;
  let isTruncated: boolean;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: key,
        ContinuationToken: continuationToken,
      }),
    );

    const objectKeys = (response.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((k): k is string => !!k && !k.endsWith('/'));

    const BATCH = 50;
    for (let i = 0; i < objectKeys.length; i += BATCH) {
      await Promise.all(
        objectKeys.slice(i, i + BATCH).map(async (objKey) => {
          const objUri = `s3://${bucket}/${objKey}`;
          const bytes = await getObjectBytes(client, bucket, objKey, objUri);
          const relKey = objKey.slice(key.length).replace(/^\/+/, '');
          files.set(relKey, bytes);
        }),
      );
    }

    isTruncated = response.IsTruncated ?? false;
    continuationToken = response.NextContinuationToken;
  } while (isTruncated);

  return { files };
}

export async function fetchS3(uri: string): Promise<S3Result> {
  const client = new S3Client({});
  try {
    const isDir = uri.endsWith('/');
    const { bucket, key } = parseS3Uri(uri, isDir);
    return isDir
      ? await fetchS3Prefix(client, bucket, key, uri)
      : await fetchS3Object(client, bucket, key, uri);
  } finally {
    client.destroy();
  }
}
