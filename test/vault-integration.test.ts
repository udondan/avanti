import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchVault } from '../src/sources/vault';

const CLI = resolve(__dirname, '../src/cli.ts');
const PROJECT_ROOT = resolve(__dirname, '..');

const hasVaultAddr = !!process.env.VAULT_ADDR?.trim();

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runAvanti(configPath: string, workingDir: string): RunResult {
  try {
    const stdout = execSync(
      `bunx tsx "${CLI}" --config "${configPath}" --working-dir "${workingDir}" pull --yes`,
      {
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 2,
    };
  }
}

function writeConfig(dir: string, content: string): string {
  const configPath = join(dir, 'avanti.yml');
  writeFileSync(configPath, content);
  return configPath;
}

// Secrets seeded in CI before this suite runs:
//   KV v2 (secret/ mount):  secret/myapp/db  → { username: 'admin', password: 's3cr3t' }
//   KV v1 (kv1/ mount):     kv1/myapp/token  → { apikey: 'v1key123' }

describe.skipIf(!hasVaultAddr)('Vault integration — HTTP API', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-vault-integration-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('KV v2', () => {
    it('fetches a single field', async () => {
      const result = await fetchVault('secret/myapp/db', 'password');
      expect(result.files.size).toBe(1);
      expect(result.files.get('password')?.toString()).toBe('s3cr3t');
    });

    it('fetches all fields as JSON keyed by secret basename', async () => {
      const result = await fetchVault('secret/myapp/db');
      expect(result.files.size).toBe(1);
      const content = result.files.get('db')?.toString();
      expect(content).toBeDefined();
      const parsed: unknown = JSON.parse(content!);
      expect(parsed).toEqual({ username: 'admin', password: 's3cr3t' });
    });

    it('throws when the requested field does not exist', async () => {
      await expect(
        fetchVault('secret/myapp/db', 'nonexistent'),
      ).rejects.toThrow('Field "nonexistent" not found');
    });

    it('throws when the secret path does not exist', async () => {
      await expect(fetchVault('secret/nonexistent/path')).rejects.toThrow(
        'HTTP 404',
      );
    });

    it('throws HTTP 403 when the token lacks permission for the path', async () => {
      await expect(fetchVault('secret/other/secret')).rejects.toThrow(
        'HTTP 403',
      );
    });
  });

  describe('KV v1 fallback', () => {
    it('fetches all fields from a KV v1 mount', async () => {
      const result = await fetchVault('kv1/myapp/token');
      expect(result.files.size).toBe(1);
      const content = result.files.get('token')?.toString();
      expect(content).toBeDefined();
      const parsed: unknown = JSON.parse(content!);
      expect(parsed).toEqual({ apikey: 'v1key123' });
    });

    it('fetches a single field from a KV v1 mount', async () => {
      const result = await fetchVault('kv1/myapp/token', 'apikey');
      expect(result.files.size).toBe(1);
      expect(result.files.get('apikey')?.toString()).toBe('v1key123');
    });
  });

  describe('end-to-end via CLI subprocess', () => {
    it('resolves a vault: source through the full config pipeline', () => {
      const config = writeConfig(
        tmpDir,
        `files:
  ./db-username.txt:
    src:
      vault:
        path: secret/myapp/db
        field: username
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);

      const output = readFileSync(join(tmpDir, 'db-username.txt'), 'utf8');
      expect(output.trim()).toBe('admin');
    });
  });
});
