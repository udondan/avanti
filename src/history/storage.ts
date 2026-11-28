import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { computeContentSha256 } from '../sha';

export function defaultBaseDir(): string {
  return (
    process.env.AVANTI_HISTORY_DIR ??
    path.join(os.homedir(), '.config', 'avanti')
  );
}

export function normalizeDir(p: string): string {
  const norm = path.normalize(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

export function sha256(input: string): string {
  return computeContentSha256(input);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
