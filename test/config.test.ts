import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';

function writeTmp(content: string): string {
  const f = path.join(os.tmpdir(), `fileferry-test-${Date.now()}.yml`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

describe('loadConfig', () => {
  it('loads a valid http src', () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = loadConfig(f);
    expect(cfg.files).toHaveLength(1);
    expect(cfg.files[0].src).toBe('https://example.com/foo.txt');
    expect(cfg.files[0].target).toBe('foo.txt');
  });

  it('loads a local path src', () => {
    const f = writeTmp(`
files:
  - src: ~/some/file.sh
    target: file.sh
    mode: "0777"
`);
    const cfg = loadConfig(f);
    expect(cfg.files[0].src).toBe('~/some/file.sh');
    expect(cfg.files[0].mode).toBe('0777');
  });

  it('loads an exec src map', () => {
    const f = writeTmp(`
files:
  - src:
      exec: echo hello
    target: out.txt
`);
    const cfg = loadConfig(f);
    const src = cfg.files[0].src;
    expect(typeof src).toBe('object');
    expect(src).toHaveProperty('exec', 'echo hello');
  });

  it('loads a gitlab src map', () => {
    const f = writeTmp(`
files:
  - src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: \$latest
`);
    const cfg = loadConfig(f);
    const src = cfg.files[0].src as {
      gitlab: { project: string; file: string; ref: string };
    };
    expect(src.gitlab.project).toBe('group/project');
    expect(src.gitlab.file).toBe('renovate.json');
    expect(src.gitlab.ref).toBe('$latest');
    expect(cfg.files[0].target).toBeUndefined();
  });

  it('loads a github src map', () => {
    const f = writeTmp(`
files:
  - src:
      github:
        repo: org/repo
        file: scripts/
        ref: main
    target: local-scripts/
`);
    const cfg = loadConfig(f);
    const src = cfg.files[0].src as {
      github: { repo: string; file: string; ref: string };
    };
    expect(src.github.repo).toBe('org/repo');
    expect(src.github.file).toBe('scripts/');
    expect(src.github.ref).toBe('main');
    expect(cfg.files[0].target).toBe('local-scripts/');
  });

  it('throws if config file not found', () => {
    expect(() => loadConfig('/nonexistent/path.yml')).toThrow(
      'Config file not found',
    );
  });

  it('throws on bad YAML', () => {
    const f = writeTmp('files: [unclosed');
    expect(() => loadConfig(f)).toThrow('Failed to parse config file');
  });

  it('throws if files is missing', () => {
    const f = writeTmp('foo: bar\n');
    expect(() => loadConfig(f)).toThrow('"files" array');
  });

  it('throws if src is missing', () => {
    const f = writeTmp('files:\n  - target: foo.txt\n');
    expect(() => loadConfig(f)).toThrow('"src" is required');
  });

  it('throws if exec src has no target', () => {
    const f = writeTmp(`
files:
  - src:
      exec: echo hello
`);
    expect(() => loadConfig(f)).toThrow(
      '"target" is required for exec/raw sources',
    );
  });

  it('throws if gitlab src missing project', () => {
    const f = writeTmp(`
files:
  - src:
      gitlab:
        file: foo.txt
`);
    expect(() => loadConfig(f)).toThrow('gitlab.project');
  });

  it('throws if github src missing repo', () => {
    const f = writeTmp(`
files:
  - src:
      github:
        file: foo.txt
`);
    expect(() => loadConfig(f)).toThrow('github.repo');
  });

  it('loads replace rules', () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.txt
    target: foo.txt
    replace:
      - from: "{EMAIL}"
        to: deemes79@googlemail.com
      - from: /\\d+/
        to: number
`);
    const cfg = loadConfig(f);
    expect(cfg.files[0].replace).toEqual([
      { from: '{EMAIL}', to: 'deemes79@googlemail.com' },
      { from: '/\\d+/', to: 'number' },
    ]);
  });

  it('loads post field', () => {
    const f = writeTmp(`
files:
  - src:
      exec: glab api "projects/foo/bar"
    target: out.yml
    post: "sed -e 's/v3/v4/g'"
`);
    const cfg = loadConfig(f);
    expect(cfg.files[0].post).toBe("sed -e 's/v3/v4/g'");
  });

  // ── multi-source ──────────────────────────────────────────────────────────

  it('loads a list src with mixed types', () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/header.txt
      - exec: echo "middle"
      - gitlab:
          project: org/repo
          file: footer.txt
          ref: main
    target: combined.txt
`);
    const cfg = loadConfig(f);
    const entry = cfg.files[0];
    expect(Array.isArray(entry.src)).toBe(true);
    const src = entry.src as unknown[];
    expect(src).toHaveLength(3);
    expect(src[0]).toBe('https://example.com/header.txt');
    expect(src[1]).toEqual({ exec: 'echo "middle"' });
    expect(src[2]).toEqual({
      gitlab: { project: 'org/repo', file: 'footer.txt', ref: 'main' },
    });
    expect(entry.target).toBe('combined.txt');
  });

  it('throws when list src has no target', () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/a.txt
      - https://example.com/b.txt
`);
    expect(() => loadConfig(f)).toThrow(
      /"target" is required when "src" is a list/,
    );
  });

  it('reports correct index in error for invalid list src item', () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/a.txt
      - 42
    target: out.txt
`);
    expect(() => loadConfig(f)).toThrow(/files\[0\]\.src\[1\]/);
  });

  // ── variables ─────────────────────────────────────────────────────────────

  it('loads a variables block', () => {
    const f = writeTmp(`
variables:
  email: you@example.com
  version: "1.2.3"
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = loadConfig(f);
    expect(cfg.variables).toEqual({
      email: 'you@example.com',
      version: '1.2.3',
    });
  });

  it('returns empty variables when block is absent', () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = loadConfig(f);
    expect(cfg.variables).toEqual({});
  });

  it('throws when variables block is not a map', () => {
    const f = writeTmp(`
variables:
  - email
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    expect(() => loadConfig(f)).toThrow('"variables" must be a map');
  });

  it('throws when a variable value is not a string', () => {
    const f = writeTmp(`
variables:
  count: 42
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    expect(() => loadConfig(f)).toThrow(
      'variables.count: value must be a string',
    );
  });

  it('throws when a reserved variable name is used', () => {
    const f = writeTmp(`
variables:
  latest: "1.0.0"
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    expect(() => loadConfig(f)).toThrow('"latest" is reserved');
  });
});
