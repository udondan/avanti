import { describe, it, expect } from 'vitest';
import {
  resolveVars,
  resolveVarsShellSafe,
  validateVariables,
} from '../src/variables';

describe('resolveVars', () => {
  it('resolves a named variable', () => {
    expect(resolveVars('hello $name', { name: 'world' })).toBe('hello world');
  });

  it('resolves multiple variables', () => {
    expect(
      resolveVars('$greeting $name', { greeting: 'hi', name: 'there' }),
    ).toBe('hi there');
  });

  it('resolves the same variable multiple times', () => {
    expect(resolveVars('$x and $x', { x: 'foo' })).toBe('foo and foo');
  });

  it('resolves an env var via $env:NAME', () => {
    process.env['TEST_VAR_XYZ'] = 'from-env';
    expect(resolveVars('value: $env:TEST_VAR_XYZ', {})).toBe('value: from-env');
    delete process.env['TEST_VAR_XYZ'];
  });

  it('resolves env var before named var in same string', () => {
    process.env['MY_HOST'] = 'localhost';
    expect(resolveVars('$env:MY_HOST/$path', { path: 'api' })).toBe(
      'localhost/api',
    );
    delete process.env['MY_HOST'];
  });

  it('preserves $latest (reserved)', () => {
    expect(resolveVars('ref: $latest', {})).toBe('ref: $latest');
  });

  it('throws on undefined named variable', () => {
    expect(() => resolveVars('$missing', {})).toThrow(
      'Undefined variable: $missing',
    );
  });

  it('throws on undefined env var', () => {
    delete process.env['DEFINITELY_NOT_SET_XYZ'];
    expect(() => resolveVars('$env:DEFINITELY_NOT_SET_XYZ', {})).toThrow(
      'Undefined environment variable: $env:DEFINITELY_NOT_SET_XYZ',
    );
  });

  it('returns value unchanged when no interpolations present', () => {
    expect(resolveVars('no variables here', { x: 'y' })).toBe(
      'no variables here',
    );
  });
});

describe('resolveVarsShellSafe', () => {
  it('wraps a plain value in single quotes', () => {
    expect(resolveVarsShellSafe('echo $name', { name: 'world' })).toBe(
      "echo 'world'",
    );
  });

  it('escapes single quotes in value', () => {
    expect(resolveVarsShellSafe('echo $msg', { msg: "it's fine" })).toBe(
      "echo 'it'\\''s fine'",
    );
  });

  it('shell-quotes env var values', () => {
    process.env['SAFE_TEST_VAR'] = 'hello; rm -rf /';
    expect(resolveVarsShellSafe('echo $env:SAFE_TEST_VAR', {})).toBe(
      "echo 'hello; rm -rf /'",
    );
    delete process.env['SAFE_TEST_VAR'];
  });

  it('passes $latest through unquoted', () => {
    expect(resolveVarsShellSafe('ref: $latest', {})).toBe('ref: $latest');
  });

  it('throws on undefined variable', () => {
    expect(() => resolveVarsShellSafe('$missing', {})).toThrow(
      'Undefined variable: $missing',
    );
  });

  it('throws on undefined env var', () => {
    delete process.env['DEFINITELY_NOT_SET_XYZ'];
    expect(() =>
      resolveVarsShellSafe('$env:DEFINITELY_NOT_SET_XYZ', {}),
    ).toThrow('Undefined environment variable: $env:DEFINITELY_NOT_SET_XYZ');
  });
});

describe('validateVariables', () => {
  it('accepts valid variable names', () => {
    expect(() =>
      validateVariables({ email: 'a@b.com', version: '1.0' }),
    ).not.toThrow();
  });

  it('throws when "latest" is used as a variable name', () => {
    expect(() => validateVariables({ latest: '1.0.0' })).toThrow(
      '"latest" is reserved',
    );
  });
});
