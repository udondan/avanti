import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { create as tarCreate } from 'tar';
import { describe, expect, it } from 'vitest';
import {
  ArchiveFormat,
  detectArchiveFormat,
  extractArchive,
} from '../src/extract';
import { applyFilter } from '../src/filter';

// Minimal ZIP containing subdir/ (dir), subdir/nested.txt ("nested\n"), hello.txt ("hello world\n")
const TEST_ZIP_BASE64 =
  'UEsDBAoAAAAAAAxLtlwAAAAAAAAAAAAAAAAHABwAc3ViZGlyL1VUCQADqAQQaqgEEGp1eAsAAQT1AQAABAAAAABQSwMECgAAAAAAEEu2XI2Vq+sHAAAABwAAABEAHABzdWJkaXIvbmVzdGVkLnR4dFVUCQADrwQQaqkEEGp1eAsAAQT1AQAABAAAAABuZXN0ZWQKUEsDBAoAAAAAABBLtlwtOwivDAAAAAwAAAAJABwAaGVsbG8udHh0VVQJAAOvBBBqqQQQanV4CwABBPUBAAAEAAAAAGhlbGxvIHdvcmxkClBLAQIeAwoAAAAAAAxLtlwAAAAAAAAAAAAAAAAHABgAAAAAAAAAEADtQQAAAABzdWJkaXIvVVQFAAOoBBBqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAAEEu2XI2Vq+sHAAAABwAAABEAGAAAAAAAAQAAAKSBQQAAAHN1YmRpci9uZXN0ZWQudHh0VVQFAAOvBBBqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAAEEu2XC07CK8MAAAADAAAAAkAGAAAAAAAAQAAAKSBkwAAAGhlbGxvLnR4dFVUBQADrwQQanV4CwABBPUBAAAEAAAAAFBLBQYAAAAAAwADAPMAAADiAAAAAAA=';

async function makeTarGz(files: Record<string, string>): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-test-'));
  try {
    const names: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      names.push(name);
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tarCreate({ gzip: true, cwd: tmpDir, portable: true }, names)
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    return Buffer.concat(chunks);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function makeTar(files: Record<string, string>): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-test-'));
  try {
    const names: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      names.push(name);
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tarCreate({ gzip: false, cwd: tmpDir, portable: true }, names)
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    return Buffer.concat(chunks);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('detectArchiveFormat', () => {
  const cases: Array<[string, ArchiveFormat | null]> = [
    ['archive.zip', 'zip'],
    ['archive.ZIP', 'zip'],
    ['release.tar.gz', 'tar.gz'],
    ['release.TGZ', 'tar.gz'],
    ['release.tgz', 'tar.gz'],
    ['release.tar.bz2', 'tar.bz2'],
    ['release.tar.xz', 'tar.xz'],
    ['release.tar', 'tar'],
    ['release.TAR', 'tar'],
    ['notes.txt', null],
    ['data.json', null],
    ['noextension', null],
  ];

  for (const [filename, expected] of cases) {
    it(`returns ${JSON.stringify(expected)} for "${filename}"`, () => {
      expect(detectArchiveFormat(filename)).toBe(expected);
    });
  }
});

describe('extractArchive — unknown format', () => {
  it('throws for unrecognised extension', async () => {
    await expect(
      extractArchive(Buffer.from('data'), 'file.txt'),
    ).rejects.toThrow('unrecognised archive format');
  });
});

describe('extractArchive — bz2/xz not yet supported', () => {
  it('throws a clear error for tar.bz2', async () => {
    await expect(
      extractArchive(Buffer.from('data'), 'archive.tar.bz2'),
    ).rejects.toThrow('not yet supported');
  });

  it('throws a clear error for tar.xz', async () => {
    await expect(
      extractArchive(Buffer.from('data'), 'archive.tar.xz'),
    ).rejects.toThrow('not yet supported');
  });
});

describe('extractArchive — ZIP', () => {
  it('extracts file entries', async () => {
    const buffer = Buffer.from(TEST_ZIP_BASE64, 'base64');
    const files = await extractArchive(buffer, 'test.zip');
    expect([...files.keys()].sort()).toEqual([
      'hello.txt',
      'subdir/nested.txt',
    ]);
  });

  it('returns correct file contents', async () => {
    const buffer = Buffer.from(TEST_ZIP_BASE64, 'base64');
    const files = await extractArchive(buffer, 'test.zip');
    expect(files.get('hello.txt')?.toString()).toBe('hello world\n');
    expect(files.get('subdir/nested.txt')?.toString()).toBe('nested\n');
  });

  it('skips directory entries', async () => {
    const buffer = Buffer.from(TEST_ZIP_BASE64, 'base64');
    const files = await extractArchive(buffer, 'test.zip');
    const keys = [...files.keys()];
    expect(keys.every((k) => !k.endsWith('/'))).toBe(true);
  });
});

describe('extractArchive — tar.gz', () => {
  it('extracts all files', async () => {
    const buffer = await makeTarGz({
      'a.txt': 'hello',
      'subdir/b.txt': 'world',
    });
    const files = await extractArchive(buffer, 'release.tar.gz');
    expect([...files.keys()].sort()).toEqual(['a.txt', 'subdir/b.txt']);
  });

  it('returns correct file contents', async () => {
    const buffer = await makeTarGz({ 'greet.txt': 'hi there' });
    const files = await extractArchive(buffer, 'release.tgz');
    expect(files.get('greet.txt')?.toString()).toBe('hi there');
  });
});

describe('extractArchive — tar', () => {
  it('extracts all files', async () => {
    const buffer = await makeTar({ 'x.txt': 'x', 'y.txt': 'y' });
    const files = await extractArchive(buffer, 'archive.tar');
    expect([...files.keys()].sort()).toEqual(['x.txt', 'y.txt']);
  });
});

describe('extractArchive — with applyFilter', () => {
  it('filters extracted files by exact match', async () => {
    const buffer = await makeTarGz({
      'readme.md': 'readme',
      'binary.exe': 'exe',
    });
    const files = await extractArchive(buffer, 'release.tar.gz');
    const filtered = applyFilter(files, ['readme.md']);
    expect([...filtered.keys()]).toEqual(['readme.md']);
  });

  it('filters extracted files by prefix', async () => {
    const buffer = await makeTarGz({
      'assets/img.png': 'img',
      'assets/logo.svg': 'svg',
      'docs/readme.md': 'docs',
    });
    const files = await extractArchive(buffer, 'release.tgz');
    const filtered = applyFilter(files, ['assets/']);
    expect([...filtered.keys()].sort()).toEqual([
      'assets/img.png',
      'assets/logo.svg',
    ]);
  });

  it('filters extracted files by regex', async () => {
    const buffer = await makeTarGz({
      'photo.jpg': 'jpg',
      'photo.png': 'png',
      'notes.txt': 'txt',
    });
    const files = await extractArchive(buffer, 'release.tar.gz');
    const filtered = applyFilter(files, ['/\\.jpg$/']);
    expect([...filtered.keys()]).toEqual(['photo.jpg']);
  });
});

describe('applyFilter — prefix pattern', () => {
  function mapOf(entries: Record<string, string>): Map<string, Buffer> {
    return new Map(
      Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, 'utf8')]),
    );
  }

  it('matches all files under a directory prefix', () => {
    const files = mapOf({
      'assets/a.png': '',
      'assets/b.png': '',
      'other/c.txt': '',
    });
    const result = applyFilter(files, ['assets/']);
    expect([...result.keys()].sort()).toEqual(['assets/a.png', 'assets/b.png']);
  });

  it('does not match files outside the prefix', () => {
    const files = mapOf({
      'assets/img.png': '',
      'assets-other/img.png': '',
    });
    const result = applyFilter(files, ['assets/']);
    expect([...result.keys()]).toEqual(['assets/img.png']);
  });

  it('matches nested paths under prefix', () => {
    const files = mapOf({
      'a/b/c.txt': '',
      'a/b/d.txt': '',
      'a/other.txt': '',
    });
    const result = applyFilter(files, ['a/b/']);
    expect([...result.keys()].sort()).toEqual(['a/b/c.txt', 'a/b/d.txt']);
  });

  it('combines prefix with other pattern types', () => {
    const files = mapOf({
      'assets/img.png': '',
      'docs/readme.md': '',
      'exact.txt': '',
      'other/x.js': '',
    });
    const result = applyFilter(files, ['assets/', '/\\.md$/', 'exact.txt']);
    expect([...result.keys()].sort()).toEqual([
      'assets/img.png',
      'docs/readme.md',
      'exact.txt',
    ]);
  });
});
