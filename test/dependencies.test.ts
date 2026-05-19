import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sortByDependencies } from '../src/dependencies';
import { FileEntry } from '../src/types';

function entry(target: string, src: unknown): FileEntry {
  return { target, src } as FileEntry;
}

describe('sortByDependencies', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-deps-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns original order when there are no dependencies', () => {
    const entries: [string, FileEntry][] = [
      ['a', entry('a.txt', 'https://example.com/a.txt')],
      ['b', entry('b.txt', 'https://example.com/b.txt')],
      ['c', entry('c.txt', 'https://example.com/c.txt')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('places dependency before the entry that needs it', () => {
    const aPath = join(tmpDir, 'a.txt');
    const entries: [string, FileEntry][] = [
      ['b', entry('b.txt', aPath)],
      ['a', entry('a.txt', { raw: 'hello' })],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('handles a longer chain A→B→C', () => {
    const aPath = join(tmpDir, 'a.txt');
    const bPath = join(tmpDir, 'b.txt');
    const entries: [string, FileEntry][] = [
      ['c', entry('c.txt', bPath)],
      ['b', entry('b.txt', aPath)],
      ['a', entry('a.txt', 'https://example.com/a.txt')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('preserves original order for independent entries', () => {
    const entries: [string, FileEntry][] = [
      ['z', entry('z.txt', 'https://example.com/z')],
      ['m', entry('m.txt', 'https://example.com/m')],
      ['a', entry('a.txt', 'https://example.com/a')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['z', 'm', 'a']);
  });

  it('resolves relative source paths against workingDir', () => {
    const entries: [string, FileEntry][] = [
      ['b', entry('b.txt', 'a.txt')],
      ['a', entry('a.txt', 'https://example.com/a')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('skips edges for sources that are not targets of any entry', () => {
    const entries: [string, FileEntry][] = [
      ['a', entry('a.txt', 'not-a-target.txt')],
      ['b', entry('b.txt', 'also-not-a-target.txt')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('handles {path:} style sources', () => {
    const aPath = join(tmpDir, 'a.txt');
    const entries: [string, FileEntry][] = [
      ['b', entry('b.txt', { path: aPath })],
      ['a', entry('a.txt', 'https://example.com/a')],
    ];
    const result = sortByDependencies(entries, tmpDir, {});
    expect(result.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('detects a simple cycle and throws', () => {
    const aPath = join(tmpDir, 'a.txt');
    const bPath = join(tmpDir, 'b.txt');
    const entries: [string, FileEntry][] = [
      ['a', entry('a.txt', bPath)],
      ['b', entry('b.txt', aPath)],
    ];
    expect(() => sortByDependencies(entries, tmpDir, {})).toThrow(
      'Circular dependency detected',
    );
  });

  it('cycle error message lists the involved keys', () => {
    const aPath = join(tmpDir, 'a.txt');
    const bPath = join(tmpDir, 'b.txt');
    const entries: [string, FileEntry][] = [
      ['a', entry('a.txt', bPath)],
      ['b', entry('b.txt', aPath)],
    ];
    expect(() => sortByDependencies(entries, tmpDir, {})).toThrow(/a.*b|b.*a/);
  });

  it('resolves variables in target paths', () => {
    const entries: [string, FileEntry][] = [
      ['b', entry('b.txt', resolve(tmpDir, 'a.txt'))],
      ['a', entry('$dir/a.txt', 'https://example.com/a')],
    ];
    const vars = { dir: tmpDir };
    const result = sortByDependencies(entries, tmpDir, vars);
    expect(result.map(([k]) => k)).toEqual(['a', 'b']);
  });
});
