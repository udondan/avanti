import { spawnSync } from 'child_process';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';

export interface VaultResult {
  files: Map<string, string>;
}

function isVaultAvailable(): boolean {
  return !spawnSync('vault', ['version'], { encoding: 'utf8' }).error;
}

function vaultRun(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('vault', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`vault CLI error: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function secretFilename(secretPath: string, field?: string): string {
  return field ?? (path.basename(secretPath) || 'secret');
}

function fetchVaultViaCli(secretPath: string, field?: string): VaultResult {
  const filename = secretFilename(secretPath, field);

  if (field) {
    const res = vaultRun(['kv', 'get', `-field=${field}`, secretPath]);
    if (res.status !== 0) {
      throw new Error(`Failed to read ${secretPath}: ${res.stderr.trim()}`);
    }
    return { files: new Map([[filename, res.stdout]]) };
  }

  const res = vaultRun(['kv', 'get', '-format=json', secretPath]);
  if (res.status !== 0) {
    throw new Error(`Failed to read ${secretPath}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  const kvv2 = (parsed?.data as Record<string, unknown>)?.data;
  const data = kvv2 ?? parsed?.data;
  if (!data) throw new Error(`No data found at ${secretPath}`);
  return { files: new Map([[filename, JSON.stringify(data, null, 2)]]) };
}

async function fetchVaultViaApi(
  addr: string,
  token: string,
  secretPath: string,
  field?: string,
): Promise<VaultResult> {
  const headers: Record<string, string> = {
    'X-Vault-Token': token,
    'User-Agent': 'avanti',
  };
  const namespace = process.env.VAULT_NAMESPACE;
  if (namespace) headers['X-Vault-Namespace'] = namespace;

  const filename = secretFilename(secretPath, field);
  const parts = secretPath.split('/');
  const mount = parts[0];
  const subpath = parts.slice(1).join('/');

  // Try KV v2 path first
  const v2Res = await fetchWithRetry(`${addr}/v1/${mount}/data/${subpath}`, {
    headers,
  });
  if (v2Res.ok) {
    const json = (await v2Res.json()) as Record<string, unknown>;
    const data = (json?.data as Record<string, unknown>)?.data as Record<
      string,
      unknown
    >;
    if (data) {
      if (field) {
        if (!(field in data))
          throw new Error(`Field "${field}" not found at ${secretPath}`);
        return { files: new Map([[filename, String(data[field])]]) };
      }
      return {
        files: new Map([[filename, JSON.stringify(data, null, 2)]]),
      };
    }
  }

  // Fall back to KV v1 path
  const v1Res = await fetchWithRetry(`${addr}/v1/${secretPath}`, { headers });
  if (!v1Res.ok) {
    throw new Error(`Failed to read ${secretPath}: HTTP ${v1Res.status}`);
  }
  const json = (await v1Res.json()) as Record<string, unknown>;
  const data = json?.data as Record<string, unknown>;
  if (!data) throw new Error(`No data found at ${secretPath}`);
  if (field) {
    if (!(field in data))
      throw new Error(`Field "${field}" not found at ${secretPath}`);
    return { files: new Map([[filename, String(data[field])]]) };
  }
  return { files: new Map([[filename, JSON.stringify(data, null, 2)]]) };
}

export async function fetchVault(
  secretPath: string,
  field?: string,
): Promise<VaultResult> {
  if (isVaultAvailable()) {
    return fetchVaultViaCli(secretPath, field);
  }

  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  if (addr && token) {
    return fetchVaultViaApi(addr, token, secretPath, field);
  }

  throw new Error(
    'vault CLI not found and VAULT_ADDR/VAULT_TOKEN env vars are not set',
  );
}
