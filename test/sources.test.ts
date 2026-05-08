import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchSource } from '../src/sources';

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
      const content = result.files.get('docker-compose.yaml')!;
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
        result.files.get('out.yml')!,
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
      const parsed = parseDocument(result.files.get('out.yml')!).toJSON() as {
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
        result.files.get('out.yaml')!,
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
      const parsed = JSON.parse(result.files.get('merged.json')!) as unknown;
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
      const parsed = JSON.parse(result.files.get('merged.json')!) as unknown;
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
