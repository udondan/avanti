import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { expandBraces, expandTilde } from '../src/paths';

describe('expandTilde', () => {
  it('expands bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('expands ~/subdir to a subdirectory of home', () => {
    expect(expandTilde('~/subdir')).toBe(path.join(os.homedir(), 'subdir'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandTilde('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path');
  });
});

describe('expandBraces', () => {
  it('returns the pattern unchanged when there are no braces', () => {
    expect(expandBraces('some/path/foo')).toEqual(['some/path/foo']);
  });

  it('expands a single brace group', () => {
    expect(expandBraces('some/path/{foo,bar}')).toEqual([
      'some/path/foo',
      'some/path/bar',
    ]);
  });

  it('leaves a single-alternative brace group (no comma) unexpanded', () => {
    expect(expandBraces('some/{foo}')).toEqual(['some/{foo}']);
  });

  it('expands multiple brace groups', () => {
    expect(expandBraces('{a,b}/{x,y}')).toEqual(['a/x', 'a/y', 'b/x', 'b/y']);
  });

  it('preserves prefix and suffix around the brace group', () => {
    expect(expandBraces('prefix-{one,two}-suffix')).toEqual([
      'prefix-one-suffix',
      'prefix-two-suffix',
    ]);
  });

  it('leaves empty braces unexpanded', () => {
    expect(expandBraces('some/{}')).toEqual(['some/{}']);
  });

  it('expands brace group with extension', () => {
    expect(expandBraces('config/{dev,prod}.yml')).toEqual([
      'config/dev.yml',
      'config/prod.yml',
    ]);
  });
});
