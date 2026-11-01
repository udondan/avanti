import { describe, it, expect } from 'vitest';
import {
  isLatestSentinel,
  isRecentSentinel,
  maxSemverTag,
  parseRefPattern,
  SEMVER_PATTERN,
} from '../src/ref';

describe('SEMVER_PATTERN', () => {
  it.each(['1.2.3', 'v1.2.3', 'v10.20.300'])(
    'matches stable semver tag %s',
    (tag) => {
      expect(SEMVER_PATTERN.test(tag)).toBe(true);
    },
  );

  it.each([
    'v1.2.3-rc.1',
    'v1.2.3-beta',
    'v1.2.3.4',
    'nightly',
    'latest',
    'main',
    '',
    'v1',
    'v1.2',
  ])('does not match %s', (tag) => {
    expect(SEMVER_PATTERN.test(tag)).toBe(false);
  });
});

describe('isLatestSentinel', () => {
  it('returns true for $latest', () => {
    expect(isLatestSentinel('$latest')).toBe(true);
  });

  it('returns false for other values', () => {
    expect(isLatestSentinel('$recent')).toBe(false);
    expect(isLatestSentinel('main')).toBe(false);
    expect(isLatestSentinel(undefined)).toBe(false);
  });
});

describe('isRecentSentinel', () => {
  it('returns true for $recent', () => {
    expect(isRecentSentinel('$recent')).toBe(true);
  });

  it('returns false for other values', () => {
    expect(isRecentSentinel('$latest')).toBe(false);
    expect(isRecentSentinel('main')).toBe(false);
    expect(isRecentSentinel(undefined)).toBe(false);
  });
});

describe('parseRefPattern', () => {
  it('returns null for a plain ref', () => {
    expect(parseRefPattern('main')).toBeNull();
    expect(parseRefPattern('$latest')).toBeNull();
    expect(parseRefPattern('v1.2.3')).toBeNull();
  });

  it('parses a simple regex pattern', () => {
    const re = parseRefPattern('/^v\\d+\\.\\d+\\.\\d+$/');
    expect(re).not.toBeNull();
    expect(re!.test('v1.2.3')).toBe(true);
    expect(re!.test('nightly')).toBe(false);
  });

  it('parses a pattern with flags', () => {
    const re = parseRefPattern('/^release/i');
    expect(re).not.toBeNull();
    expect(re!.flags).toContain('i');
    expect(re!.test('Release-1.0')).toBe(true);
  });

  it('parses a pattern containing a slash', () => {
    const re = parseRefPattern('/foo\\/bar/');
    expect(re).not.toBeNull();
    expect(re!.test('foo/bar')).toBe(true);
  });

  it('returns null for empty pattern //', () => {
    expect(parseRefPattern('//')).toBeNull();
  });

  it('strips stateful g and y flags', () => {
    const re = parseRefPattern('/^v\\d+/gi');
    expect(re).not.toBeNull();
    expect(re!.flags).not.toContain('g');
    expect(re!.flags).toContain('i');
  });

  it('strips y flag while preserving other flags', () => {
    const re = parseRefPattern('/^release/iy');
    expect(re).not.toBeNull();
    expect(re!.flags).not.toContain('y');
    expect(re!.flags).toContain('i');
  });

  it('throws on an invalid regex', () => {
    expect(() => parseRefPattern('/[invalid/')).toThrow('Invalid ref pattern');
  });
});

describe('maxSemverTag', () => {
  it('returns null when no tag is semver', () => {
    expect(maxSemverTag([])).toBeNull();
    expect(maxSemverTag(['main', 'v1.2'])).toBeNull();
  });

  it('compares major, minor and patch numerically', () => {
    expect(maxSemverTag(['v1.9.9', 'v2.0.0', 'v1.10.0'])).toBe('v2.0.0');
    expect(maxSemverTag(['1.2.0', '1.10.0', '1.9.5'])).toBe('1.10.0');
    expect(maxSemverTag(['v1.2.10', 'v1.2.9', 'nightly'])).toBe('v1.2.10');
    expect(maxSemverTag(['v3.0.0', 'v1.0.0'])).toBe('v3.0.0');
  });
});
