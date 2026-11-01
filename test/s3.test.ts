import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockDestroy, basenameOverride } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
  // When set, path.basename returns this value instead of the real result.
  // Used to simulate keys that have no basename on some platforms (e.g. a
  // drive-letter key like "C:" on Windows).
  basenameOverride: { value: undefined as string | undefined },
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  const basename = (p: string, ext?: string) =>
    basenameOverride.value ?? actual.basename(p, ext);
  return { ...actual, default: { ...actual, basename }, basename };
});

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = mockSend;
    destroy = mockDestroy;
  }
  return { S3Client, GetObjectCommand: vi.fn(), ListObjectsV2Command: vi.fn() };
});

import { fetchS3 } from '../src/sources/s3';
import { setVerbose } from '../src/logger';

function fakeBody(content: string) {
  return {
    transformToByteArray: () => Promise.resolve(Buffer.from(content)),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('fetchS3 — single object', () => {
  it('fetches a single file and returns it keyed by basename', async () => {
    mockSend.mockResolvedValueOnce({ Body: fakeBody('hello world') });

    const result = await fetchS3('s3://my-bucket/path/to/file.txt');

    expect(result.files.get('file.txt')?.toString('utf8')).toBe('hello world');
    expect(result.files.size).toBe(1);
  });

  it('throws when Body is missing', async () => {
    mockSend.mockResolvedValueOnce({ Body: undefined });

    await expect(fetchS3('s3://my-bucket/path/to/file.txt')).rejects.toThrow(
      'No body returned',
    );
  });

  it('throws for an invalid S3 URI', async () => {
    await expect(fetchS3('not-an-s3-uri')).rejects.toThrow('Invalid S3 URI');
  });

  it('throws when no object key is provided (bucket-only URI)', async () => {
    await expect(fetchS3('s3://my-bucket')).rejects.toThrow(
      'S3 object key is required',
    );
  });

  it('destroys the client in a finally block on success', async () => {
    mockSend.mockResolvedValueOnce({ Body: fakeBody('data') });

    await fetchS3('s3://my-bucket/file.txt');

    expect(mockDestroy).toHaveBeenCalled();
  });

  it('destroys the client in a finally block on error', async () => {
    mockSend.mockRejectedValueOnce(new Error('network error'));

    await expect(fetchS3('s3://my-bucket/file.txt')).rejects.toThrow(
      'network error',
    );
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('names the file "download" when the key has no basename', async () => {
    mockSend.mockResolvedValueOnce({ Body: fakeBody('data') });
    basenameOverride.value = '';
    try {
      const result = await fetchS3('s3://my-bucket/C:');
      expect([...result.files.keys()]).toEqual(['download']);
    } finally {
      basenameOverride.value = undefined;
    }
  });
});

describe('fetchS3 — directory prefix', () => {
  it('fetches all objects under a prefix', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
        NextContinuationToken: undefined,
      })
      .mockResolvedValueOnce({ Body: fakeBody('content') })
      .mockResolvedValueOnce({ Body: fakeBody('content') });

    const result = await fetchS3('s3://my-bucket/prefix/');

    expect(result.files.has('a.txt')).toBe(true);
    expect(result.files.has('b.txt')).toBe(true);
    expect(result.files.size).toBe(2);
  });

  it('preserves file content per object', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
        NextContinuationToken: undefined,
      })
      // Promise.all maps synchronously so a.txt is fetched first, b.txt second
      .mockResolvedValueOnce({ Body: fakeBody('content-a') })
      .mockResolvedValueOnce({ Body: fakeBody('content-b') });

    const result = await fetchS3('s3://my-bucket/prefix/');

    expect(result.files.get('a.txt')?.toString('utf8')).toBe('content-a');
    expect(result.files.get('b.txt')?.toString('utf8')).toBe('content-b');
  });

  it('handles pagination via NextContinuationToken', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/page1.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'token-abc',
      })
      .mockResolvedValueOnce({ Body: fakeBody('page1') })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/page2.txt' }],
        IsTruncated: false,
        NextContinuationToken: undefined,
      })
      .mockResolvedValueOnce({ Body: fakeBody('page2') });

    const result = await fetchS3('s3://my-bucket/prefix/');

    expect(result.files.get('page1.txt')?.toString('utf8')).toBe('page1');
    expect(result.files.get('page2.txt')?.toString('utf8')).toBe('page2');
    expect(result.files.size).toBe(2);
  });

  it('skips directory placeholder keys (trailing slash)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/' }, { Key: 'prefix/real.txt' }],
        NextContinuationToken: undefined,
      })
      .mockResolvedValueOnce({ Body: fakeBody('real') });

    const result = await fetchS3('s3://my-bucket/prefix/');

    expect(result.files.size).toBe(1);
    expect(result.files.get('real.txt')?.toString('utf8')).toBe('real');
  });

  it('returns an empty map when the prefix has no objects', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [],
      NextContinuationToken: undefined,
    });

    const result = await fetchS3('s3://my-bucket/empty-prefix/');

    expect(result.files.size).toBe(0);
  });

  it('treats a listing without Contents as empty', async () => {
    mockSend.mockResolvedValueOnce({ NextContinuationToken: undefined });

    const result = await fetchS3('s3://my-bucket/empty-prefix/');

    expect(result.files.size).toBe(0);
  });

  it('throws when an object Body is missing', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/missing.txt' }],
        NextContinuationToken: undefined,
      })
      .mockResolvedValueOnce({ Body: undefined });

    await expect(fetchS3('s3://my-bucket/prefix/')).rejects.toThrow(
      'No body returned',
    );
  });
});

describe('fetchS3 — verbose logging', () => {
  it('logs each GetObject under a prefix when verbose is enabled', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setVerbose(true);
    try {
      mockSend
        .mockResolvedValueOnce({ Contents: [{ Key: 'prefix/a.txt' }] })
        .mockResolvedValueOnce({ Body: fakeBody('content') });
      await fetchS3('s3://my-bucket/prefix/');
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('s3 GetObject s3://my-bucket/prefix/a.txt');
    } finally {
      setVerbose(false);
      stderrSpy.mockRestore();
    }
  });

  it('logs a single-object GetObject when verbose is enabled', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setVerbose(true);
    try {
      mockSend.mockResolvedValueOnce({ Body: fakeBody('content') });
      await fetchS3('s3://my-bucket/file.txt');
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('s3 GetObject s3://my-bucket/file.txt');
    } finally {
      setVerbose(false);
      stderrSpy.mockRestore();
    }
  });
});
