import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLocal } from '../src/sources/local';
import { fetchHttp } from '../src/sources/http';
import { _testable } from '../src/fetch';
import { fetchSource } from '../src/sources';

describe('fetchLocal — ~/  expansion', () => {
  it('expands ~/ to os.homedir()', () => {
    const slug = `avanti-nonexistent-${Date.now()}-${process.pid}`;
    const expectedPath = join(homedir(), slug);
    expect(() => fetchLocal(`~/${slug}`, tmpdir())).toThrow(expectedPath);
  });
});

describe('fetchLocal — optional flag', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-sources-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns content for an existing file', () => {
    const file = join(tmpDir, 'hello.txt');
    writeFileSync(file, 'hello');
    const result = fetchLocal(file, tmpDir);
    expect(result.files.get('hello.txt')?.toString('utf8')).toBe('hello');
  });

  it('throws for a missing file when optional is false', () => {
    expect(() =>
      fetchLocal(join(tmpDir, 'nonexistent.txt'), tmpDir, false),
    ).toThrow(/Local source not found/);
  });

  it('throws for a missing file when optional is omitted', () => {
    expect(() => fetchLocal(join(tmpDir, 'nonexistent.txt'), tmpDir)).toThrow(
      /Local source not found/,
    );
  });

  it('returns empty map with missing=true for a missing file when optional is true', () => {
    const result = fetchLocal(join(tmpDir, 'nonexistent.txt'), tmpDir, true);
    expect(result.files.size).toBe(0);
    expect(result.missing).toBe(true);
  });

  it('returns empty map without missing flag for an existing empty directory', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir);
    const result = fetchLocal(emptyDir, tmpDir, true);
    expect(result.files.size).toBe(0);
    expect(result.missing).toBeUndefined();
  });
});

describe('fetchHttp — optional flag', () => {
  beforeEach(() => {
    vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for a 404 when optional is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );
    const result = await fetchHttp('https://example.com/missing.txt', true);
    expect(result).toBeNull();
  });

  it('throws for a 404 when optional is false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );
    await expect(
      fetchHttp('https://example.com/missing.txt', false),
    ).rejects.toThrow('HTTP 404');
  });

  it('throws for a 500 even when optional is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 }),
    );
    await expect(
      fetchHttp('https://example.com/error.txt', true),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('fetchSource — local directory → single file target', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-sources-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('YAML merge', () => {
    it('auto-detects YAML merge when all files have .yaml extension', async () => {
      const srcDir = join(tmpDir, 'services');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'db.yaml'), 'db:\n  host: localhost\n');
      writeFileSync(join(srcDir, 'app.yaml'), 'app:\n  port: 8080\n');

      const result = await fetchSource(
        { src: srcDir, target: 'docker-compose.yaml' },
        tmpDir,
      );

      expect(result.files.size).toBe(1);
      expect(result.files.has('docker-compose.yaml')).toBe(true);
      const content = result.files.get('docker-compose.yaml')!.toString('utf8');
      const { parseDocument } = await import('yaml');
      const parsed = parseDocument(content).toJSON() as unknown;
      expect(parsed).toMatchObject({
        db: { host: 'localhost' },
        app: { port: 8080 },
      });
    });

    it('auto-detects YAML merge when all files have .yml extension', async () => {
      const srcDir = join(tmpDir, 'services');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.yml'), 'x: 1\n');
      writeFileSync(join(srcDir, 'b.yml'), 'y: 2\n');

      const result = await fetchSource(
        { src: srcDir, target: 'out.yml' },
        tmpDir,
      );

      expect(result.files.size).toBe(1);
      const { parseDocument } = await import('yaml');
      const parsed = parseDocument(
        result.files.get('out.yml')!.toString('utf8'),
      ).toJSON() as unknown;
      expect(parsed).toEqual({ x: 1, y: 2 });
    });

    it('sorts files alphabetically before merging', async () => {
      const srcDir = join(tmpDir, 'services');
      mkdirSync(srcDir);
      // z first, a second — merge order must be a then z (alphabetical)
      writeFileSync(join(srcDir, 'z-override.yml'), 'key: z\n');
      writeFileSync(join(srcDir, 'a-base.yml'), 'key: a\n');

      const result = await fetchSource(
        { src: srcDir, target: 'out.yml' },
        tmpDir,
      );

      const { parseDocument } = await import('yaml');
      const parsed = parseDocument(
        result.files.get('out.yml')!.toString('utf8'),
      ).toJSON() as {
        key: string;
      };
      // z-override.yml comes after a-base.yml → last_wins default
      expect(parsed.key).toBe('z');
    });

    it('respects explicit yaml: true option', async () => {
      const srcDir = join(tmpDir, 'mixed');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.txt'), 'from: a\n');
      writeFileSync(join(srcDir, 'b.txt'), 'extra: 1\n');

      const result = await fetchSource(
        { src: srcDir, target: 'out.yaml', yaml: true },
        tmpDir,
      );

      expect(result.files.size).toBe(1);
      const { parseDocument } = await import('yaml');
      const parsed = parseDocument(
        result.files.get('out.yaml')!.toString('utf8'),
      ).toJSON() as unknown;
      expect(parsed).toMatchObject({ from: 'a', extra: 1 });
    });

    it('respects yaml: false to suppress auto-merge and mirror directory', async () => {
      const srcDir = join(tmpDir, 'services');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.yml'), 'x: 1\n');
      writeFileSync(join(srcDir, 'b.yml'), 'y: 2\n');

      const result = await fetchSource(
        { src: srcDir, target: './output/', yaml: false },
        tmpDir,
      );

      // Should preserve the multi-file map (directory mirroring)
      expect(result.files.size).toBe(2);
    });
  });

  describe('JSON merge', () => {
    it('auto-detects JSON merge when all files have .json extension', async () => {
      const srcDir = join(tmpDir, 'configs');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.json'), JSON.stringify({ a: 1 }));
      writeFileSync(join(srcDir, 'b.json'), JSON.stringify({ b: 2 }));

      const result = await fetchSource(
        { src: srcDir, target: 'merged.json' },
        tmpDir,
      );

      expect(result.files.size).toBe(1);
      const parsed = JSON.parse(
        result.files.get('merged.json')!.toString('utf8'),
      ) as unknown;
      expect(parsed).toMatchObject({ a: 1, b: 2 });
    });

    it('respects explicit json: true option', async () => {
      const srcDir = join(tmpDir, 'configs');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.txt'), '{"x":1}');
      writeFileSync(join(srcDir, 'b.txt'), '{"y":2}');

      const result = await fetchSource(
        { src: srcDir, target: 'merged.json', json: true },
        tmpDir,
      );

      expect(result.files.size).toBe(1);
      const parsed = JSON.parse(
        result.files.get('merged.json')!.toString('utf8'),
      ) as unknown;
      expect(parsed).toMatchObject({ x: 1, y: 2 });
    });
  });

  describe('directory mirroring (no merge)', () => {
    it('mirrors directory when target ends with /', async () => {
      const srcDir = join(tmpDir, 'src');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.yml'), 'x: 1\n');
      writeFileSync(join(srcDir, 'b.yml'), 'y: 2\n');

      const result = await fetchSource(
        { src: srcDir, target: './output/' },
        tmpDir,
      );

      expect(result.files.size).toBe(2);
      expect(result.files.has('a.yml')).toBe(true);
      expect(result.files.has('b.yml')).toBe(true);
    });

    it('mirrors directory when files have mixed extensions', async () => {
      const srcDir = join(tmpDir, 'mixed');
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'a.yml'), 'x: 1\n');
      writeFileSync(join(srcDir, 'b.txt'), 'hello\n');

      const result = await fetchSource(
        { src: srcDir, target: 'out.yml' },
        tmpDir,
      );

      // Mixed extensions → no auto-detect → mirrors
      expect(result.files.size).toBe(2);
    });
  });
});

describe('fetchSource — path source type', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-sources-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches an existing file via path src', async () => {
    const file = join(tmpDir, 'data.txt');
    writeFileSync(file, 'content');
    const result = await fetchSource(
      { src: { path: file }, target: 'data.txt' },
      tmpDir,
    );
    expect(result.files.get('data.txt')?.toString('utf8')).toBe('content');
  });

  it('throws for a missing path src without optional', async () => {
    await expect(
      fetchSource(
        { src: { path: join(tmpDir, 'missing.txt') }, target: 'out.txt' },
        tmpDir,
      ),
    ).rejects.toThrow(/Local source not found/);
  });

  it('returns empty files map for a missing optional path src', async () => {
    const result = await fetchSource(
      {
        src: { path: join(tmpDir, 'missing.txt'), optional: true },
        target: 'out.txt',
      },
      tmpDir,
    );
    expect(result.files.size).toBe(0);
    expect(result.sourceRecords).toHaveLength(0);
  });

  it('skips missing optional path in array without injecting blank line', async () => {
    const file = join(tmpDir, 'base.txt');
    writeFileSync(file, 'first');
    const result = await fetchSource(
      {
        src: [
          file,
          { path: join(tmpDir, 'missing.txt'), optional: true },
          { path: file },
        ],
        target: 'out.txt',
      },
      tmpDir,
    );
    expect(result.files.get('out.txt')?.toString('utf8')).toBe('first\nfirst');
  });
});

describe('fetchSource — url source type', () => {
  beforeEach(() => {
    vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty files map for optional url src returning 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );
    const result = await fetchSource(
      {
        src: { url: 'https://example.com/missing.txt', optional: true },
        target: 'out.txt',
      },
      tmpdir(),
    );
    expect(result.files.size).toBe(0);
    expect(result.sourceRecords).toHaveLength(0);
  });

  it('throws for optional url src returning 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 }),
    );
    await expect(
      fetchSource(
        {
          src: { url: 'https://example.com/error.txt', optional: true },
          target: 'out.txt',
        },
        tmpdir(),
      ),
    ).rejects.toThrow('HTTP 500');
  });

  it('skips missing optional url in array without injecting blank line', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('second', { status: 200 }));
    const result = await fetchSource(
      {
        src: [
          { url: 'https://example.com/missing.txt', optional: true },
          'https://example.com/second.txt',
        ],
        target: 'out.txt',
      },
      tmpdir(),
    );
    expect(result.files.get('out.txt')?.toString('utf8')).toBe('second');
  });

  it('returns empty files map when all array sources are skipped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );
    const result = await fetchSource(
      {
        src: [
          { url: 'https://example.com/a.txt', optional: true },
          { url: 'https://example.com/b.txt', optional: true },
        ],
        target: 'out.txt',
      },
      tmpdir(),
    );
    expect(result.files.size).toBe(0);
    expect(result.sourceRecords).toHaveLength(0);
  });
});

describe('FetchCache — cross-target deduplication', () => {
  beforeEach(() => {
    vi.spyOn(_testable, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches an identical URL only once across different targets when a shared cache is provided', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response('content', { status: 200 })),
      );

    const cache = new Map();

    await fetchSource(
      { src: 'https://example.com/shared.txt', target: 'a.txt' },
      tmpdir(),
      {},
      cache,
    );
    await fetchSource(
      { src: 'https://example.com/shared.txt', target: 'b.txt' },
      tmpdir(),
      {},
      cache,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
