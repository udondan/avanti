import * as path from 'path';
import { Readable } from 'stream';
import { Parser, ReadEntry } from 'tar';
import unzipper from 'unzipper';

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz';

export function detectArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.bz2')) return 'tar.bz2';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

function normalizePath(p: string): string | null {
  const normalized = path.posix.normalize(p.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') return null;
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(
      `Archive contains unsafe entry path "${p}" — rejecting to prevent path traversal`,
    );
  }
  return normalized;
}

async function extractZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const directory = await unzipper.Open.buffer(buffer);
  const files = new Map<string, Buffer>();
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const normalized = normalizePath(entry.path);
    if (normalized === null) continue;
    if (files.has(normalized)) {
      throw new Error(
        `Archive contains duplicate path "${normalized}" (original entry: "${entry.path}")`,
      );
    }
    files.set(normalized, await entry.buffer());
  }
  return files;
}

async function extractTar(buffer: Buffer): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser();
    parser.on('entry', (entry: ReadEntry) => {
      if (
        entry.type !== 'File' &&
        entry.type !== 'OldFile' &&
        entry.type !== 'ContiguousFile'
      ) {
        entry.resume();
        return;
      }
      let normalized: string | null;
      try {
        normalized = normalizePath(entry.path);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reject(error);
        entry.resume();
        return;
      }
      if (normalized === null) {
        entry.resume();
        return;
      }
      const key = normalized;
      const originalPath = entry.path;
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        if (files.has(key)) {
          reject(
            new Error(
              `Archive contains duplicate path "${key}" (original entry: "${originalPath}")`,
            ),
          );
          return;
        }
        files.set(key, Buffer.concat(chunks));
      });
      entry.on('error', reject);
    });
    parser.on('finish', resolve);
    parser.on('error', reject);
    Readable.from([buffer]).pipe(parser);
  });
  return files;
}

export async function extractArchive(
  buffer: Buffer,
  filename: string,
): Promise<Map<string, Buffer>> {
  const format = detectArchiveFormat(filename);
  if (format === null) {
    throw new Error(
      `Cannot extract "${filename}": unrecognised archive format (.zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz)`,
    );
  }
  if (format === 'zip') return extractZip(buffer);
  if (format === 'tar.bz2' || format === 'tar.xz') {
    throw new Error(
      `Cannot extract "${filename}": ${format} is not yet supported; decompress the file first with bzip2/xz`,
    );
  }
  return extractTar(buffer);
}
