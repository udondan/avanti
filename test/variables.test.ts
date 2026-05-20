import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import * as path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  resolveVars,
  resolveVarsShellSafe,
  validateVariables,
  buildFileVars,
  buildDateVars,
  resolveBackupCounter,
  assertBackupPathAllowed,
  resolveBackupPath,
} from '../src/variables';
import { resolveVariableSpec } from '../src/variables-remote';
import { isWindows } from '../src/shell';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-vars-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  it.each([
    'path',
    'filename',
    'basename',
    'ext',
    'dirname',
    'basedir',
    'date',
    'datetime',
  ])('throws when "%s" is used as a variable name', (name) => {
    expect(() => validateVariables({ [name]: 'value' })).toThrow(
      `"${name}" is reserved`,
    );
  });
});

describe('buildFileVars', () => {
  it('derives all path variables from a target path', () => {
    const p = '/home/user/project/config.yaml';
    const v = buildFileVars(p);
    expect(v.path).toBe(p);
    expect(v.filename).toBe('config.yaml');
    expect(v.basename).toBe('config');
    expect(v.ext).toBe('yaml');
    expect(v.dirname).toBe('/home/user/project');
    expect(v.basedir).toBe('project');
  });

  it('handles a file with no extension', () => {
    const v = buildFileVars('/some/dir/Makefile');
    expect(v.filename).toBe('Makefile');
    expect(v.basename).toBe('Makefile');
    expect(v.ext).toBe('');
  });

  it('handles a dotfile (leading dot, no extension)', () => {
    const v = buildFileVars('/home/user/.bashrc');
    expect(v.filename).toBe('.bashrc');
    expect(v.basename).toBe('.bashrc');
    expect(v.ext).toBe('');
  });

  it('handles a double extension', () => {
    const v = buildFileVars('/tmp/archive.tar.gz');
    expect(v.filename).toBe('archive.tar.gz');
    expect(v.basename).toBe('archive.tar');
    expect(v.ext).toBe('gz');
  });
});

describe('buildDateVars', () => {
  it('returns date in YYYY-MM-DD format', () => {
    const now = new Date('2026-05-20T14:30:00');
    const v = buildDateVars(now);
    expect(v.date).toBe('2026-05-20');
  });

  it('returns datetime in YYYY-MM-DD-HH-mm-ss format', () => {
    const now = new Date('2026-05-20T14:30:05');
    const v = buildDateVars(now);
    expect(v.datetime).toBe('2026-05-20-14-30-05');
  });

  it('zero-pads month, day, hours, minutes, seconds', () => {
    const now = new Date('2026-01-02T03:04:05');
    const v = buildDateVars(now);
    expect(v.date).toBe('2026-01-02');
    expect(v.datetime).toBe('2026-01-02-03-04-05');
  });
});

describe('resolveBackupCounter', () => {
  it('returns the pattern unchanged when no counter token is present', () => {
    expect(resolveBackupCounter('/tmp/file.bkp')).toBe('/tmp/file.bkp');
  });

  it('returns slot 01 when no existing files match', () => {
    const pattern = path.join(tmpDir, 'config.%dd.yaml');
    const result = resolveBackupCounter(pattern);
    expect(result).toBe(path.join(tmpDir, 'config.01.yaml'));
  });

  it('increments to the next available slot', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.01.yaml'), '');
    fs.writeFileSync(path.join(tmpDir, 'config.02.yaml'), '');
    const pattern = path.join(tmpDir, 'config.%dd.yaml');
    expect(resolveBackupCounter(pattern)).toBe(
      path.join(tmpDir, 'config.03.yaml'),
    );
  });

  it('uses width-1 slot for %d', () => {
    const pattern = path.join(tmpDir, 'file.%d.bkp');
    expect(resolveBackupCounter(pattern)).toBe(path.join(tmpDir, 'file.1.bkp'));
  });

  it('uses width-3 slot for %ddd', () => {
    const pattern = path.join(tmpDir, 'file.%ddd.bkp');
    expect(resolveBackupCounter(pattern)).toBe(
      path.join(tmpDir, 'file.001.bkp'),
    );
  });

  it('throws when all slots are exhausted', () => {
    fs.writeFileSync(path.join(tmpDir, 'f.1.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.2.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.3.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.4.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.5.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.6.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.7.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.8.bkp'), '');
    fs.writeFileSync(path.join(tmpDir, 'f.9.bkp'), '');
    const pattern = path.join(tmpDir, 'f.%d.bkp');
    expect(() => resolveBackupCounter(pattern)).toThrow('counter exhausted');
  });

  it('throws when multiple counter tokens appear', () => {
    expect(() => resolveBackupCounter('/tmp/f.%dd.%dd.bkp')).toThrow(
      'at most one counter token',
    );
  });

  it('throws when counter width exceeds maximum (> 3)', () => {
    expect(() =>
      resolveBackupCounter(path.join(tmpDir, 'f.%dddd.bkp')),
    ).toThrow('exceeds maximum');
  });
});

describe('assertBackupPathAllowed', () => {
  it('allows a path within workingDir', () => {
    expect(() =>
      assertBackupPathAllowed('/work/backups/file.bkp', '/work', []),
    ).not.toThrow();
  });

  it('allows the workingDir itself', () => {
    expect(() => assertBackupPathAllowed('/work', '/work', [])).not.toThrow();
  });

  it('blocks a path outside workingDir with no backup_roots', () => {
    expect(() => assertBackupPathAllowed('/tmp/file.bkp', '/work', [])).toThrow(
      'outside the working directory',
    );
  });

  it('allows a path under a declared backup_root', () => {
    expect(() =>
      assertBackupPathAllowed('/tmp/backups/file.bkp', '/work', [
        '/tmp/backups',
      ]),
    ).not.toThrow();
  });

  it('blocks a path not covered by any backup_root', () => {
    expect(() =>
      assertBackupPathAllowed('/etc/passwd', '/work', ['/tmp/backups']),
    ).toThrow('outside the working directory');
  });

  it('allows a path under a ~/expanded backup_root', () => {
    const home = os.homedir();
    expect(() =>
      assertBackupPathAllowed(path.join(home, 'backups', 'file.bkp'), '/work', [
        '~/backups',
      ]),
    ).not.toThrow();
  });
});

describe('resolveBackupPath', () => {
  it('resolves $filename in a workingDir-relative pattern', () => {
    const targetPath = path.join(tmpDir, 'config.yaml');
    const result = resolveBackupPath(
      'backups/$filename',
      targetPath,
      tmpDir,
      {},
      [],
    );
    expect(result).toBe(path.join(tmpDir, 'backups', 'config.yaml'));
  });

  it('resolves all per-file vars', () => {
    const targetPath = path.join(tmpDir, 'src', 'app.ts');
    const result = resolveBackupPath(
      '$dirname/$basename.bkp.$ext',
      targetPath,
      tmpDir,
      {},
      [path.join(tmpDir, 'src')],
    );
    expect(result).toBe(path.join(tmpDir, 'src', 'app.bkp.ts'));
  });

  it('resolves $date and $datetime from vars', () => {
    const targetPath = path.join(tmpDir, 'file.txt');
    const vars = buildDateVars(new Date('2026-05-20T10:00:00'));
    const result = resolveBackupPath(
      '$dirname/$filename.$date',
      targetPath,
      tmpDir,
      vars,
      [],
    );
    expect(result).toBe(path.join(tmpDir, 'file.txt.2026-05-20'));
  });

  it('resolves a %dd counter in the pattern', () => {
    const targetPath = path.join(tmpDir, 'cfg.yaml');
    const result = resolveBackupPath(
      '$dirname/$basename.%dd.$ext',
      targetPath,
      tmpDir,
      {},
      [],
    );
    expect(result).toBe(path.join(tmpDir, 'cfg.01.yaml'));
  });

  it('throws when backup path escapes workingDir without a root', () => {
    const targetPath = path.join(tmpDir, 'cfg.yaml');
    expect(() =>
      resolveBackupPath('/etc/cfg.bkp', targetPath, tmpDir, {}, []),
    ).toThrow('outside the working directory');
  });

  it('throws when backup path resolves to the target file itself', () => {
    const targetPath = path.join(tmpDir, 'cfg.yaml');
    expect(() =>
      resolveBackupPath('$path', targetPath, tmpDir, {}, []),
    ).toThrow('resolves to the target file itself');
  });

  it('allows an absolute path under a declared backup_root', () => {
    const targetPath = path.join(tmpDir, 'cfg.yaml');
    const backupRoot = path.join(tmpDir, 'bkp');
    const result = resolveBackupPath(
      path.join(backupRoot, '$filename'),
      targetPath,
      tmpDir,
      {},
      [backupRoot],
    );
    expect(result).toBe(path.join(backupRoot, 'cfg.yaml'));
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
