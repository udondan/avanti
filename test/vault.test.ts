import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchVault } from '../src/sources/vault';

// We mock child_process so vault CLI calls are controlled
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'child_process';
import type { MockInstance } from 'vitest';
// spawnSync is replaced by vi.fn() above; cast to access mock methods
const mockSpawnSync = spawnSync as unknown as MockInstance;

function makeSpawnResult(opts: {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: Error;
}) {
  return {
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    status: opts.status ?? 0,
    pid: 0,
    output: [],
    signal: null,
    error: opts.error,
  } as ReturnType<typeof spawnSync>;
}

// Helper to set up the vault-available check (first spawnSync call is 'vault version')
function makeVaultAvailable(stdout = 'Vault v1.15.0') {
  return makeSpawnResult({ stdout, status: 0 });
}

function makeVaultUnavailable() {
  return makeSpawnResult({ error: new Error('ENOENT'), status: null });
}

beforeEach(() => {
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  delete process.env.VAULT_NAMESPACE;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  delete process.env.VAULT_NAMESPACE;
});

describe('fetchVault — CLI path', () => {
  it('fetches a single field via vault kv get -field=...', async () => {
    mockSpawnSync
      .mockReturnValueOnce(makeVaultAvailable()) // isVaultAvailable: vault version
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'mysecret', status: 0 })); // vault kv get -field=password

    const result = await fetchVault('secret/myapp/db', 'password');

    expect(result.files.get('password')).toBe('mysecret');

    // Verify the args used
    const callArgs = mockSpawnSync.mock.calls[1]?.[1] as string[];
    expect(callArgs).toContain('-field=password');
    expect(callArgs).toContain('secret/myapp/db');
  });

  it('fetches all fields in KV v2 format (parsed.data.data)', async () => {
    const kvv2Payload = JSON.stringify({
      data: {
        data: { username: 'admin', password: 'hunter2' },
        metadata: {},
      },
    });

    mockSpawnSync
      .mockReturnValueOnce(makeVaultAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: kvv2Payload, status: 0 }));

    const result = await fetchVault('secret/myapp/db');

    const filename = 'db'; // basename of 'secret/myapp/db'
    const content = result.files.get(filename);
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!) as Record<string, string>;
    expect(parsed).toEqual({ username: 'admin', password: 'hunter2' });
  });

  it('fetches all fields in KV v1 format (parsed.data, no .data.data)', async () => {
    const kvv1Payload = JSON.stringify({
      data: { apikey: 'xyz123' },
    });

    mockSpawnSync
      .mockReturnValueOnce(makeVaultAvailable())
      .mockReturnValueOnce(makeSpawnResult({ stdout: kvv1Payload, status: 0 }));

    const result = await fetchVault('secret/myapp/token');

    const filename = 'token';
    const content = result.files.get(filename);
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!) as Record<string, string>;
    expect(parsed).toEqual({ apikey: 'xyz123' });
  });

  it('throws when CLI returns non-zero status', async () => {
    mockSpawnSync
      .mockReturnValueOnce(makeVaultAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: '', stderr: 'permission denied', status: 2 }),
      );

    await expect(fetchVault('secret/myapp/db', 'password')).rejects.toThrow(
      'permission denied',
    );
  });

  it('throws when CLI errors during all-fields fetch', async () => {
    mockSpawnSync
      .mockReturnValueOnce(makeVaultAvailable())
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: '', stderr: 'secret not found', status: 1 }),
      );

    await expect(fetchVault('secret/myapp/missing')).rejects.toThrow(
      'secret not found',
    );
  });
});

describe('fetchVault — HTTP API path', () => {
  beforeEach(() => {
    // CLI unavailable for all HTTP tests
    mockSpawnSync.mockReturnValue(makeVaultUnavailable());
    process.env.VAULT_ADDR = 'https://vault.example.com';
    process.env.VAULT_TOKEN = 'test-token';
  });

  it('reads KV v2 secret via HTTP (tries /v1/<mount>/data/<subpath> first)', async () => {
    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { data: { username: 'admin' }, metadata: {} },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchVault('secret/myapp/db');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://vault.example.com/v1/secret/data/myapp/db',
      expect.any(Object),
    );
    const content = result.files.get('db');
    expect(JSON.parse(content!)).toEqual({ username: 'admin' });
  });

  it('falls back to KV v1 when v2 returns non-ok', async () => {
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 })) // v2 miss
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { apikey: 'v1key' } }), {
          status: 200,
        }),
      );

    const result = await fetchVault('secret/myapp/token');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const content = result.files.get('token');
    expect(JSON.parse(content!)).toEqual({ apikey: 'v1key' });
  });

  it('extracts specific field from KV v2 response via HTTP', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { data: { password: 's3cr3t', user: 'admin' }, metadata: {} },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchVault('secret/myapp/db', 'password');
    expect(result.files.get('password')).toBe('s3cr3t');
  });

  it('throws when field not found in v2 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { data: { user: 'admin' }, metadata: {} },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchVault('secret/myapp/db', 'missing_field'),
    ).rejects.toThrow('Field "missing_field" not found');
  });

  it('throws when HTTP request fails (both v2 and v1)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 403 })) // v2 fails
      .mockResolvedValue(new Response(null, { status: 403 })); // v1 fails

    await expect(fetchVault('secret/myapp/db')).rejects.toThrow('HTTP 403');
  });

  it('sends X-Vault-Token and X-Vault-Namespace headers when VAULT_NAMESPACE is set', async () => {
    process.env.VAULT_NAMESPACE = 'myns';
    const mockFetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { data: { key: 'val' }, metadata: {} } }),
          { status: 200 },
        ),
      );

    await fetchVault('secret/myapp/ns');

    const [, callInit] = mockFetch.mock.calls[0];
    expect(callInit?.headers).toMatchObject({
      'X-Vault-Token': 'test-token',
      'X-Vault-Namespace': 'myns',
    });

    delete process.env.VAULT_NAMESPACE;
  });
});

describe('fetchVault — no CLI, no env vars', () => {
  it('throws when neither CLI nor VAULT_ADDR/VAULT_TOKEN are available', async () => {
    mockSpawnSync.mockReturnValue(makeVaultUnavailable());
    // env vars already deleted in beforeEach

    await expect(fetchVault('secret/myapp/db')).rejects.toThrow(
      'vault CLI not found',
    );
  });
});
