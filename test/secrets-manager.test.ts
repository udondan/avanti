import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockDestroy, mockConstructor } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
  mockConstructor: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => {
  class SecretsManagerClient {
    constructor(config?: unknown) {
      mockConstructor(config);
    }
    send = mockSend;
    destroy = mockDestroy;
  }
  return {
    SecretsManagerClient,
    GetSecretValueCommand: vi.fn(),
  };
});

import { fetchSecretsManager } from '../src/sources/secrets-manager';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('fetchSecretsManager — string secrets', () => {
  it('returns raw secret string keyed by basename', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'my-password' });

    const result = await fetchSecretsManager('myapp/prod/db');

    expect(result.files.get('db')?.toString('utf8')).toBe('my-password');
    expect(result.files.size).toBe(1);
  });

  it('extracts a specific key from a JSON secret', async () => {
    mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ username: 'admin', password: 'secret' }),
    });

    const result = await fetchSecretsManager('myapp/prod/db', 'password');

    expect(result.files.get('db')?.toString('utf8')).toBe('secret');
  });

  it('throws when the JSON key does not exist', async () => {
    mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ username: 'admin' }),
    });

    await expect(
      fetchSecretsManager('myapp/prod/db', 'missing_key'),
    ).rejects.toThrow('key "missing_key" not found');
  });

  it('throws when secret is not valid JSON but key is requested', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'not-json' });

    await expect(
      fetchSecretsManager('myapp/prod/db', 'somekey'),
    ).rejects.toThrow('not valid JSON');
  });
});

describe('fetchSecretsManager — binary secrets', () => {
  it('returns binary secret as Buffer', async () => {
    const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    mockSend.mockResolvedValueOnce({ SecretBinary: binary });

    const result = await fetchSecretsManager('myapp/prod/cert');

    expect(result.files.get('cert')).toEqual(binary);
  });

  it('throws when key is requested but secret is binary', async () => {
    const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    mockSend.mockResolvedValueOnce({ SecretBinary: binary });

    await expect(
      fetchSecretsManager('myapp/prod/cert', 'somekey'),
    ).rejects.toThrow('binary');
  });

  it('uses leaf name from ARN as filename', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'val' });

    const result = await fetchSecretsManager(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecretName',
    );

    expect(result.files.has('MySecretName')).toBe(true);
  });
});

describe('fetchSecretsManager — error handling', () => {
  it('throws when no secret value is returned', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(fetchSecretsManager('myapp/prod/db')).rejects.toThrow(
      'No secret value returned',
    );
  });

  it('destroys the client on success', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'val' });

    await fetchSecretsManager('myapp/prod/db');

    expect(mockDestroy).toHaveBeenCalled();
  });

  it('destroys the client on error', async () => {
    mockSend.mockRejectedValueOnce(new Error('auth error'));

    await expect(fetchSecretsManager('myapp/prod/db')).rejects.toThrow(
      'auth error',
    );
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('passes region to the client', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'val' });

    await fetchSecretsManager('myapp/prod/db', undefined, 'eu-west-1');

    expect(mockConstructor).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });
});
