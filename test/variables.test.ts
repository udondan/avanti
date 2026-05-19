import { join } from 'path';
import { describe, it, expect } from 'vitest';
import {
  resolveVars,
  resolveVarsShellSafe,
  validateVariables,
} from '../src/variables';
import { resolveVariableSpec } from '../src/variables-remote';
import { isWindows } from '../src/shell';

const FIXTURES = join(__dirname, 'fixtures/templates');

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

  it('treats $$ as a literal $', () => {
    expect(resolveVars('$$name', { name: 'world' })).toBe('$name');
  });

  it('treats $$env:NAME as a literal $env:NAME without resolving', () => {
    const prior = process.env['SHOULD_NOT_RESOLVE'];
    process.env['SHOULD_NOT_RESOLVE'] = 'oops';
    try {
      expect(resolveVars('$$env:SHOULD_NOT_RESOLVE', {})).toBe(
        '$env:SHOULD_NOT_RESOLVE',
      );
    } finally {
      if (prior === undefined) delete process.env['SHOULD_NOT_RESOLVE'];
      else process.env['SHOULD_NOT_RESOLVE'] = prior;
    }
  });

  it('handles $$$ as literal $ followed by variable substitution', () => {
    expect(resolveVars('$$$name', { name: 'world' })).toBe('$world');
  });
});

describe('resolveVarsShellSafe', () => {
  it('wraps a plain value in single quotes', () => {
    expect(resolveVarsShellSafe('echo $name', { name: 'world' })).toBe(
      "echo 'world'",
    );
  });

  it('escapes single quotes in value', () => {
    // POSIX: ' → '\''   PowerShell: ' → ''
    const expected = isWindows ? "echo 'it''s fine'" : "echo 'it'\\''s fine'";
    expect(resolveVarsShellSafe('echo $msg', { msg: "it's fine" })).toBe(
      expected,
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

  it('treats $$ as a literal $ without substitution', () => {
    expect(resolveVarsShellSafe('$$true', {})).toBe('$true');
  });

  it('treats $$env:NAME as literal without resolving or quoting', () => {
    const prior = process.env['SHOULD_NOT_RESOLVE'];
    process.env['SHOULD_NOT_RESOLVE'] = 'oops';
    try {
      expect(resolveVarsShellSafe('$$env:SHOULD_NOT_RESOLVE', {})).toBe(
        '$env:SHOULD_NOT_RESOLVE',
      );
    } finally {
      if (prior === undefined) delete process.env['SHOULD_NOT_RESOLVE'];
      else process.env['SHOULD_NOT_RESOLVE'] = prior;
    }
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

  it('throws when "self" is used as a variable name', () => {
    expect(() => validateVariables({ self: '/some/path' })).toThrow(
      '"self" is reserved',
    );
  });
});

describe('resolveVariableSpec', () => {
  const cwd = process.cwd();

  it('returns empty object for empty spec', async () => {
    expect(await resolveVariableSpec({}, cwd)).toEqual({});
  });

  it('passes plain string variables through unchanged', async () => {
    const result = await resolveVariableSpec({ foo: 'bar', baz: 'qux' }, cwd);
    expect(result).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('resolves references in plain string variables to prior variables', async () => {
    const result = await resolveVariableSpec(
      { prefix: 'hello', msg: '$prefix world' },
      cwd,
    );
    expect(result).toEqual({ prefix: 'hello', msg: 'hello world' });
  });

  it('throws on forward reference in plain string variable', async () => {
    await expect(resolveVariableSpec({ b: '$a', a: 'x' }, cwd)).rejects.toThrow(
      'Undefined variable: $a',
    );
  });

  it('fetches a raw source and trims whitespace', async () => {
    const result = await resolveVariableSpec(
      { token: { src: { raw: '  my-secret-token\n' } } },
      cwd,
    );
    expect(result).toEqual({ token: 'my-secret-token' });
  });

  it('resolves variables in raw source content using prior variables', async () => {
    const result = await resolveVariableSpec(
      { base: 'hello', greeting: { src: { raw: '$base world' } } },
      cwd,
    );
    expect(result).toEqual({ base: 'hello', greeting: 'hello world' });
  });

  it('throws when raw source references a forward variable', async () => {
    await expect(
      resolveVariableSpec(
        { greeting: { src: { raw: '$later' } }, later: 'x' },
        cwd,
      ),
    ).rejects.toThrow('Undefined variable: $later');
  });

  it('mix of string and source-based variables resolves in order', async () => {
    const result = await resolveVariableSpec(
      {
        host: 'registry.example.com',
        token: { src: { raw: 'abc123\n' } },
        url: 'https://$host',
        line: { src: { raw: '//$host/:_authToken=$token' } },
      },
      cwd,
    );
    expect(result).toEqual({
      host: 'registry.example.com',
      token: 'abc123',
      url: 'https://registry.example.com',
      line: '//registry.example.com/:_authToken=abc123',
    });
  });

  it('throws when source resolves to no content (all-optional empty)', async () => {
    await expect(
      resolveVariableSpec(
        {
          tok: {
            src: { path: '/nonexistent-avanti-test-path', optional: true },
          },
        },
        cwd,
      ),
    ).rejects.toThrow('variables.tok: source resolved to no content');
  });

  it('wraps fetch errors with variable location context', async () => {
    await expect(
      resolveVariableSpec(
        { tok: { src: { path: '/definitely-does-not-exist-avanti' } } },
        cwd,
      ),
    ).rejects.toThrow('variables.tok:');
  });

  it('renders a source variable through a template engine', async () => {
    const result = await resolveVariableSpec(
      {
        env: 'prod',
        label: {
          src: { raw: 'env={{env}}\n' },
          template: 'handlebars',
        },
      },
      cwd,
    );
    expect(result.label).toBe('env=prod');
  });

  it('template variable can reference prior variables in its context', async () => {
    const result = await resolveVariableSpec(
      {
        version: '1.2.3',
        tag: {
          src: { raw: 'v{{ version }}' },
          template: 'nunjucks',
        },
      },
      cwd,
    );
    expect(result.tag).toBe('v1.2.3');
  });

  it('template rendering error on a variable is wrapped with location context', async () => {
    await expect(
      resolveVariableSpec(
        { bad: { src: { raw: '{{missing}}' }, template: 'handlebars' } },
        cwd,
      ),
    ).rejects.toThrow('variables.bad: template rendering failed');
  });

  it('template: true on a variable auto-detects engine from source file extension', async () => {
    const result = await resolveVariableSpec(
      {
        app: 'myapp',
        version: '1.2.3',
        rendered: {
          src: { path: join(FIXTURES, 'app.hbs') },
          template: true,
        },
      },
      cwd,
    );
    expect(result.rendered.replace(/\r\n/g, '\n')).toBe(
      'app: myapp\nversion: 1.2.3\nurl: https://example.com/myapp/1.2.3',
    );
  });
});
