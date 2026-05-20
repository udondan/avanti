import { describe, it, expect } from 'vitest';
import { expandBraces } from '../src/paths';

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
