import { describe, expect, it } from 'vitest';
import { applyFilter, expandBraces } from '../src/filter';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function mapOf(entries: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, buf(v)]));
}

describe('expandBraces', () => {
  it('returns the pattern unchanged when no braces', () => {
    expect(expandBraces('file.txt')).toEqual(['file.txt']);
  });

  it('expands single-level braces', () => {
    expect(expandBraces('file-{a,b,c}.yml')).toEqual([
      'file-a.yml',
      'file-b.yml',
      'file-c.yml',
    ]);
  });

  it('expands braces at start', () => {
    expect(expandBraces('{foo,bar}.txt')).toEqual(['foo.txt', 'bar.txt']);
  });

  it('expands braces at end', () => {
    expect(expandBraces('file.{yml,yaml}')).toEqual(['file.yml', 'file.yaml']);
  });

  it('expands nested braces', () => {
    expect(expandBraces('{a,{b,c}}.txt')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('handles single alternative', () => {
    expect(expandBraces('{only}.txt')).toEqual(['only.txt']);
  });

  it('handles unclosed brace as literal', () => {
    expect(expandBraces('file{a.txt')).toEqual(['file{a.txt']);
  });
});

describe('applyFilter — exact match', () => {
  it('keeps only exactly matching files', () => {
    const files = mapOf({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const result = applyFilter(files, ['a.txt']);
    expect([...result.keys()]).toEqual(['a.txt']);
  });

  it('keeps multiple exact-matched files', () => {
    const files = mapOf({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const result = applyFilter(files, ['a.txt', 'c.txt']);
    expect([...result.keys()].sort()).toEqual(['a.txt', 'c.txt']);
  });
});

describe('applyFilter — brace expansion', () => {
  it('expands and matches brace patterns', () => {
    const files = mapOf({
      'file-a.yml': 'a',
      'file-b.yml': 'b',
      'file-c.yml': 'c',
      'file-d.yml': 'd',
    });
    const result = applyFilter(files, ['file-{a,b}.yml']);
    expect([...result.keys()].sort()).toEqual(['file-a.yml', 'file-b.yml']);
  });
});

describe('applyFilter — regex', () => {
  it('matches files by regex', () => {
    const files = mapOf({
      'photo.jpg': '',
      'photo.png': '',
      'notes.txt': '',
      'some-image.jpg': '',
    });
    const result = applyFilter(files, ['/\\.jpg$/']);
    expect([...result.keys()].sort()).toEqual(['photo.jpg', 'some-image.jpg']);
  });

  it('matches anchored regex', () => {
    const files = mapOf({ 'abc.yml': '', 'xabc.yml': '', 'other.yml': '' });
    const result = applyFilter(files, ['/^abc/']);
    expect([...result.keys()]).toEqual(['abc.yml']);
  });

  it('matches regex against full relative path', () => {
    const files = mapOf({
      'subdir/config.yml': '',
      'config.yml': '',
      'other.txt': '',
    });
    const result = applyFilter(files, ['/config\\.yml$/']);
    expect([...result.keys()].sort()).toEqual([
      'config.yml',
      'subdir/config.yml',
    ]);
  });
});

describe('applyFilter — mixed patterns', () => {
  it('combines exact, brace, and regex patterns', () => {
    const files = mapOf({
      'exact.png': '',
      'file-a.yml': '',
      'file-b.yml': '',
      'photo.jpg': '',
      'notes.txt': '',
    });
    const result = applyFilter(files, [
      'exact.png',
      'file-{a,b}.yml',
      '/\\.jpg$/',
    ]);
    expect([...result.keys()].sort()).toEqual([
      'exact.png',
      'file-a.yml',
      'file-b.yml',
      'photo.jpg',
    ]);
  });
});

describe('applyFilter — no match throws', () => {
  it('throws when no files match', () => {
    const files = mapOf({ 'a.txt': 'a' });
    expect(() => applyFilter(files, ['b.txt'])).toThrow(
      'filter matched no files',
    );
  });

  it('throws with pattern info in error message', () => {
    const files = mapOf({ 'a.txt': 'a' });
    expect(() => applyFilter(files, ['x.txt', 'y.txt'])).toThrow('2 patterns');
  });
});
