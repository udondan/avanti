import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockDestroy, mockConstructor } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
  mockConstructor: vi.fn(),
}));

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {
    constructor(config?: unknown) {
      mockConstructor(config);
    }
    send = mockSend;
    destroy = mockDestroy;
  }
  return {
    SSMClient,
    GetParameterCommand: vi.fn(),
    GetParametersByPathCommand: vi.fn(),
  };
});

import { fetchSsm } from '../src/sources/ssm';
import { setVerbose } from '../src/logger';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('fetchSsm — single parameter', () => {
  it('fetches a parameter and returns it keyed by basename', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Name: '/myapp/prod/db-host', Value: 'db.example.com' },
    });

    const result = await fetchSsm('/myapp/prod/db-host');

    expect(result.files.get('db-host')?.toString('utf8')).toBe(
      'db.example.com',
    );
    expect(result.files.size).toBe(1);
  });

  it('throws when no value is returned', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: {} });

    await expect(fetchSsm('/myapp/prod/missing')).rejects.toThrow(
      'No value returned',
    );
  });

  it('destroys the client on success', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Name: '/myapp/param', Value: 'val' },
    });

    await fetchSsm('/myapp/param');

    expect(mockDestroy).toHaveBeenCalled();
  });

  it('destroys the client on error', async () => {
    mockSend.mockRejectedValueOnce(new Error('access denied'));

    await expect(fetchSsm('/myapp/param')).rejects.toThrow('access denied');
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('passes region to the client', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Name: '/myapp/param', Value: 'val' },
    });

    await fetchSsm('/myapp/param', 'ap-southeast-1');

    expect(mockConstructor).toHaveBeenCalledWith({ region: 'ap-southeast-1' });
  });
});

describe('fetchSsm — path prefix', () => {
  it('fetches all parameters under a path', async () => {
    mockSend.mockResolvedValueOnce({
      Parameters: [
        { Name: '/myapp/prod/host', Value: 'db.example.com' },
        { Name: '/myapp/prod/port', Value: '5432' },
      ],
      NextToken: undefined,
    });

    const result = await fetchSsm('/myapp/prod/');

    expect(result.files.get('host')?.toString('utf8')).toBe('db.example.com');
    expect(result.files.get('port')?.toString('utf8')).toBe('5432');
    expect(result.files.size).toBe(2);
  });

  it('handles pagination via NextToken', async () => {
    mockSend
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/myapp/prod/host', Value: 'db.example.com' }],
        NextToken: 'token-abc',
      })
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/myapp/prod/port', Value: '5432' }],
        NextToken: undefined,
      });

    const result = await fetchSsm('/myapp/prod/');

    expect(result.files.size).toBe(2);
    expect(result.files.get('host')?.toString('utf8')).toBe('db.example.com');
    expect(result.files.get('port')?.toString('utf8')).toBe('5432');
  });

  it('keys parameters by relative path under prefix to avoid basename collisions', async () => {
    mockSend.mockResolvedValueOnce({
      Parameters: [
        { Name: '/myapp/prod/db/host', Value: 'db.example.com' },
        { Name: '/myapp/prod/cache/host', Value: 'cache.example.com' },
      ],
      NextToken: undefined,
    });

    const result = await fetchSsm('/myapp/prod/');

    expect(result.files.get('db/host')?.toString('utf8')).toBe(
      'db.example.com',
    );
    expect(result.files.get('cache/host')?.toString('utf8')).toBe(
      'cache.example.com',
    );
    expect(result.files.size).toBe(2);
  });

  it('returns an empty map when path has no parameters', async () => {
    mockSend.mockResolvedValueOnce({ Parameters: [], NextToken: undefined });

    const result = await fetchSsm('/myapp/empty/');

    expect(result.files.size).toBe(0);
  });

  it('skips parameters missing a name or value', async () => {
    mockSend.mockResolvedValueOnce({
      Parameters: [
        { Name: '/myapp/prod/host', Value: 'db.example.com' },
        { Name: undefined, Value: 'orphan' },
        { Name: '/myapp/prod/novalue', Value: undefined },
      ],
      NextToken: undefined,
    });

    const result = await fetchSsm('/myapp/prod/');

    expect(result.files.size).toBe(1);
    expect(result.files.get('host')?.toString('utf8')).toBe('db.example.com');
  });

  it('treats a response without a Parameters list as empty', async () => {
    mockSend.mockResolvedValueOnce({ NextToken: undefined });

    const result = await fetchSsm('/myapp/prod/');

    expect(result.files.size).toBe(0);
  });

  it('keys a parameter by its basename when it has no path below the prefix', async () => {
    mockSend.mockResolvedValueOnce({
      Parameters: [{ Name: '/myapp/prod', Value: 'self' }],
      NextToken: undefined,
    });

    const result = await fetchSsm('/myapp/prod/');

    expect([...result.files.keys()]).toEqual(['prod']);
  });
});

describe('fetchSsm — edge cases', () => {
  it('names the file "parameter" when the name has no basename', async () => {
    mockSend.mockResolvedValueOnce({ Parameter: { Name: '', Value: 'val' } });

    const result = await fetchSsm('');

    expect([...result.files.keys()]).toEqual(['parameter']);
  });

  it('logs GetParameter and GetParametersByPath when verbose is enabled', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setVerbose(true);
    try {
      mockSend
        .mockResolvedValueOnce({ Parameter: { Name: '/a/b', Value: 'v' } })
        .mockResolvedValueOnce({ Parameters: [], NextToken: undefined });
      await fetchSsm('/a/b');
      await fetchSsm('/a/');
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('ssm GetParameter /a/b');
      expect(output).toContain('ssm GetParametersByPath /a/');
    } finally {
      setVerbose(false);
      stderrSpy.mockRestore();
    }
  });
});
