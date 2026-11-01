import { describe, it, expect } from 'vitest';
import { parseConfigContent } from '../src/config';

// JSON is valid YAML, so configs are built as JS objects and serialised.
function parse(config: unknown) {
  return parseConfigContent(JSON.stringify(config));
}

function withEntry(entry: Record<string, unknown>, target = 'out.txt') {
  return parse({ files: { [target]: entry } });
}

function withSrc(src: unknown) {
  return withEntry({ src });
}

describe('parseConfigContent — top-level shape', () => {
  it.each([
    ['a list', '- a\n'],
    ['a scalar', 'just a string\n'],
  ])('rejects %s', (_label, content) => {
    expect(() => parseConfigContent(content)).toThrow(
      'Config must be a YAML object',
    );
  });

  it('rejects file entries that are not objects', () => {
    expect(() => parse({ files: { 'a.txt': 1 } })).toThrow(
      'files["a.txt"]: must be an object',
    );
  });
});

describe('parseConfigContent — replace rules', () => {
  it.each([
    ['not an array', 'foo', 'files["out.txt"]: "replace" must be an array'],
    [
      'a non-object rule',
      [5],
      'files["out.txt"].replace[0]: must be an object',
    ],
    [
      'a rule without from',
      [{ to: 'x' }],
      'files["out.txt"].replace[0]: "from" must be a string',
    ],
    [
      'a rule without to',
      [{ from: 'x' }],
      'files["out.txt"].replace[0]: "to" must be a string',
    ],
  ])('rejects %s', (_label, replace, message) => {
    expect(() => withEntry({ src: 'a', replace })).toThrow(message);
  });
});

describe('parseConfigContent — merge options', () => {
  it('parses ini merge options', () => {
    const cfg = withEntry({
      src: 'a',
      ini: { conflicts: 'abort', arrays: 'concat', objects: 'replace' },
    });
    expect(cfg.files['out.txt'].ini).toEqual({
      conflicts: 'abort',
      arrays: 'concat',
      objects: 'replace',
    });
  });

  it('parses json formatting options', () => {
    const cfg = withEntry({
      src: 'a',
      json: {
        indent: 'tab',
        trailing_commas: true,
        sort_keys: false,
        minify: false,
        strip_comments: true,
      },
    });
    expect(cfg.files['out.txt'].json).toEqual({
      indent: 'tab',
      trailingCommas: true,
      sortKeys: false,
      minify: false,
      stripComments: true,
    });
  });

  it('accepts a numeric json indent', () => {
    const cfg = withEntry({ src: 'a', json: { indent: 4 } });
    expect(cfg.files['out.txt'].json).toEqual({ indent: 4 });
  });

  it('rejects an invalid json indent', () => {
    expect(() => withEntry({ src: 'a', json: { indent: -1 } })).toThrow(
      'files["out.txt"].json.indent',
    );
  });

  it('rejects non-boolean json flags', () => {
    expect(() => withEntry({ src: 'a', json: { sort_keys: 'yes' } })).toThrow(
      'files["out.txt"].json.sort_keys: must be a boolean',
    );
  });
});

describe('parseConfigContent — extract', () => {
  it('rejects extract with a list of sources', () => {
    expect(() =>
      withEntry({ src: ['a.tar', 'b.tar'], extract: true }, 'dir/'),
    ).toThrow('files["dir/"].extract: cannot be used with a list of sources');
  });

  it('rejects extract into a non-directory target', () => {
    expect(() => withEntry({ src: 'a.tar', extract: true }, 'file')).toThrow(
      'files["file"].extract: target must be a directory',
    );
  });

  it('accepts extract: true', () => {
    const cfg = withEntry({ src: 'a.tar', extract: true }, 'dir/');
    expect(cfg.files['dir/'].extract).toBe(true);
  });

  it('accepts a list of glob and regex patterns', () => {
    const cfg = withEntry(
      { src: 'a.tar', extract: ['*.txt', '/^bin\\//'] },
      'dir/',
    );
    expect(cfg.files['dir/'].extract).toEqual(['*.txt', '/^bin\\//']);
  });

  it.each([
    ['an empty list', [], 'files["dir/"].extract: must not be an empty array'],
    [
      'an empty pattern',
      [''],
      'files["dir/"].extract[0]: must be a non-empty string',
    ],
    [
      'a non-string pattern',
      ['ok', 5],
      'files["dir/"].extract[1]: must be a non-empty string',
    ],
    ['an invalid regex', ['/(/'], 'files["dir/"].extract[0]: invalid regex'],
    [
      'a non-list value',
      'yes',
      'files["dir/"].extract: must be true or a non-empty array of patterns',
    ],
  ])('rejects %s', (_label, extract, message) => {
    expect(() => withEntry({ src: 'a.tar', extract }, 'dir/')).toThrow(message);
  });
});

describe('parseConfigContent — symlink edge cases', () => {
  it('rejects $self as a symlink entry', () => {
    expect(() =>
      withEntry({ src: 'avanti.yml', symlink: true }, '$self'),
    ).toThrow('files["$self"].symlink: $self cannot be a symlink entry');
  });

  it('rejects brace expansions that produce a directory target', () => {
    expect(() => withEntry({ src: 'a', symlink: true }, 'link{1,2/}')).toThrow(
      'files["link2/"] (expanded from "link{1,2/}").symlink: target must be a single file path',
    );
  });
});

describe('parseConfigContent — variables', () => {
  it('requires src on source-backed variables', () => {
    expect(() => parse({ files: {}, variables: { v: { src: null } } })).toThrow(
      'variables.v: "src" is required',
    );
  });

  it('parses boolean and object merge options on variables', () => {
    const cfg = parse({
      files: {},
      variables: {
        a: { src: 'x', json: true },
        b: { src: 'x', yaml: true },
        c: { src: 'x', yaml: { conflicts: 'abort' } },
        d: { src: 'x', toml: false },
        e: { src: 'x', toml: { arrays: 'concat' } },
        f: { src: 'x', ini: true },
        g: { src: 'x', ini: { objects: 'replace' } },
      },
    });
    expect(cfg.variables).toEqual({
      a: { src: 'x', json: true },
      b: { src: 'x', yaml: true },
      c: { src: 'x', yaml: { conflicts: 'abort' } },
      d: { src: 'x', toml: false },
      e: { src: 'x', toml: { arrays: 'concat' } },
      f: { src: 'x', ini: true },
      g: { src: 'x', ini: { objects: 'replace' } },
    });
  });
});

describe('parseConfigContent — environment', () => {
  it('rejects list values', () => {
    expect(() => parse({ files: {}, environment: { E: ['a'] } })).toThrow(
      'environment.E: value must be a string, number, boolean, or source object with "src"',
    );
  });

  it('rejects reserved variable names', () => {
    expect(() => parse({ files: {}, environment: { self: 'x' } })).toThrow(
      'self',
    );
  });

  it('requires src on source-backed entries', () => {
    expect(() =>
      parse({ files: {}, environment: { E: { src: null } } }),
    ).toThrow('environment.E: "src" is required');
  });

  it('parses a list of sources', () => {
    const cfg = parse({
      files: {},
      environment: { E: { src: [{ raw: 'a' }, 'b.txt'] } },
    });
    expect(cfg.environment).toEqual({ E: { src: [{ raw: 'a' }, 'b.txt'] } });
  });
});

describe('parseConfigContent — conditions', () => {
  const loc = 'files["out.txt"].src.if';

  it.each([
    ['a non-object', 'linux', `${loc}: must be an object`],
    [
      'only "not"',
      { not: true },
      `${loc}: must specify at least one of os, exists, exec, target_exists`,
    ],
    ['an empty os list', { os: [] }, `${loc}.os: must not be an empty array`],
    [
      'an empty exists',
      { exists: '' },
      `${loc}.exists: must be a non-empty string`,
    ],
    [
      'a non-string exec',
      { exec: 5 },
      `${loc}.exec: must be a non-empty string`,
    ],
    [
      'a non-boolean not',
      { os: 'linux', not: 'x' },
      `${loc}.not: must be a boolean`,
    ],
  ])('rejects %s', (_label, cond, message) => {
    expect(() => withSrc({ path: 'a', if: cond })).toThrow(message);
  });

  it('parses exec conditions', () => {
    const cfg = withSrc({ path: 'a', if: { exec: 'true', not: true } });
    expect(cfg.files['out.txt'].src).toEqual({
      path: 'a',
      if: { exec: 'true', not: true },
    });
  });
});

describe('parseConfigContent — source validation', () => {
  const loc = 'files["out.txt"].src';

  it.each([
    [
      'a non-string sha',
      { path: 'a', sha: 5 },
      `${loc}.sha: must be a string, got number`,
    ],
    ['an empty http url', { http: '' }, `${loc}.http`],
    ['an empty exec', { exec: '' }, `${loc}.exec: must be a non-empty string`],
    ['a non-object gitlab', { gitlab: 5 }, `${loc}.gitlab: must be an object`],
    [
      'an empty gitlab file',
      { gitlab: { project: 'g/p', file: '' } },
      `${loc}.gitlab.file: must be a non-empty string`,
    ],
    [
      'an empty gitlab release',
      { gitlab: { project: 'g/p', release: '' } },
      `${loc}.gitlab.release: must be a non-empty string`,
    ],
    [
      'gitlab release with ref',
      { gitlab: { project: 'g/p', release: 'v1', ref: 'main' } },
      `${loc}.gitlab: "ref" is not valid when using "release"`,
    ],
    [
      'a non-string gitlab via',
      { gitlab: { project: 'g/p', file: 'f', via: 5 } },
      `${loc}.gitlab.via: must be a string or array`,
    ],
    ['a non-string raw', { raw: 5 }, `${loc}.raw: must be a string`],
    ['a non-object github', { github: [] }, `${loc}.github: must be an object`],
    [
      'an empty github file',
      { github: { repo: 'o/r', file: '' } },
      `${loc}.github.file: must be a non-empty string`,
    ],
    [
      'an empty github release',
      { github: { repo: 'o/r', release: '' } },
      `${loc}.github.release: must be a non-empty string`,
    ],
    [
      'github release with ref',
      { github: { repo: 'o/r', release: 'v1', ref: 'main' } },
      `${loc}.github: "ref" is not valid when using "release"`,
    ],
    [
      'a non-object bitbucket',
      { bitbucket: 'x' },
      `${loc}.bitbucket: must be an object`,
    ],
    ['a non-object git', { git: null }, `${loc}.git: must be an object`],
    ['a non-object vault', { vault: 1 }, `${loc}.vault: must be an object`],
    ['an unknown source type', { foo: 1 }, `${loc}: unknown source type`],
  ])('rejects %s', (_label, src, message) => {
    expect(() => withSrc(src)).toThrow(message);
  });
});
