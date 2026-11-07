import { spawnSync } from 'child_process';
import * as path from 'path';
import { fetchWithRetry } from '../fetch';
import { verbose } from '../logger';

interface VaultResult {
  files: Map<string, Buffer>;
}

function isVaultAvailable(): boolean {
  const result = spawnSync('vault', ['version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
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

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function fetchVaultViaCli(secretPath: string, field?: string): VaultResult {
  const filename = secretFilename(secretPath, field);

  if (field) {
    verbose(`vault kv get -field=${field} ${secretPath}`);
    const res = vaultRun(['kv', 'get', `-field=${field}`, secretPath]);
    if (res.status !== 0) {
      throw new Error(`Failed to read ${secretPath}: ${res.stderr.trim()}`);
    }
    return { files: new Map([[filename, buf(res.stdout)]]) };
  }

  verbose(`vault kv get -format=json ${secretPath}`);
  const res = vaultRun(['kv', 'get', '-format=json', secretPath]);
  if (res.status !== 0) {
    throw new Error(`Failed to read ${secretPath}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  const kvv2 = (parsed?.data as Record<string, unknown>)?.data;
  const data = kvv2 ?? parsed?.data;
  if (!data) throw new Error(`No data found at ${secretPath}`);
  return { files: new Map([[filename, buf(JSON.stringify(data, null, 2))]]) };
}

// Builds the result for a KV secret: the whole secret as JSON, or one field.
function kvFiles(
  data: Record<string, unknown>,
  secretPath: string,
  field?: string,
): VaultResult {
  const filename = secretFilename(secretPath, field);
  if (!field) {
    return {
      files: new Map([[filename, buf(JSON.stringify(data, null, 2))]]),
    };
  }
  if (!(field in data))
    throw new Error(`Field "${field}" not found at ${secretPath}`);
  return { files: new Map([[filename, buf(String(data[field]))]]) };
}

// Reads a KV v2 secret's data; undefined when the request fails. The data
// itself may still be missing, so callers check it before use.
async function readKvV2(
  addr: string,
  secretPath: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  const parts = secretPath.split('/');
  const mount = parts[0];
  const subpath = parts.slice(1).join('/');
  const v2Res = await fetchWithRetry(`${addr}/v1/${mount}/data/${subpath}`, {
    headers,
  });
  if (!v2Res.ok) return undefined;
  const json = (await v2Res.json()) as Record<string, unknown>;
  return (json?.data as Record<string, unknown>)?.data as
    Record<string, unknown> | undefined;
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

  const fieldSuffix = field ? `#${field}` : '';
  verbose(`vault HTTP API: ${secretPath}${fieldSuffix}`);
  // Try KV v2 path first
  const v2Data = await readKvV2(addr, secretPath, headers);
  if (v2Data) return kvFiles(v2Data, secretPath, field);

  // Fall back to KV v1 path
  const v1Res = await fetchWithRetry(`${addr}/v1/${secretPath}`, { headers });
  if (!v1Res.ok) {
    throw new Error(`Failed to read ${secretPath}: HTTP ${v1Res.status}`);
  }
  const json = (await v1Res.json()) as Record<string, unknown>;
  const data = json?.data as Record<string, unknown>;
  if (!data) throw new Error(`No data found at ${secretPath}`);
  return kvFiles(data, secretPath, field);
}

export async function fetchVault(
  secretPath: string,
  field?: string,
): Promise<VaultResult> {
  if (isVaultAvailable()) {
    verbose('vault: using CLI');
    return fetchVaultViaCli(secretPath, field);
  }

  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  if (addr && token) {
    verbose('vault: using HTTP API');
    return fetchVaultViaApi(addr, token, secretPath, field);
  }

  throw new Error(
    'vault CLI not found and VAULT_ADDR/VAULT_TOKEN env vars are not set',
  );
}
