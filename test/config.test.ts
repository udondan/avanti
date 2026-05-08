import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, isRemoteConfigSpec } from '../src/config';

function writeTmp(content: string): string {
  const f = path.join(os.tmpdir(), `fileferry-test-${Date.now()}.yml`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

describe('isRemoteConfigSpec', () => {
  it('detects http URLs', () => {
    expect(isRemoteConfigSpec('http://example.com/config.yml')).toBe(true);
  });

  it('detects https URLs', () => {
    expect(isRemoteConfigSpec('https://example.com/config.yml')).toBe(true);
  });

  it('detects github: specs', () => {
    expect(isRemoteConfigSpec('github:owner/repo:config.yml')).toBe(true);
  });

  it('detects gitlab: specs', () => {
    expect(isRemoteConfigSpec('gitlab:group/project:config.yml')).toBe(true);
  });

  it('returns false for local paths', () => {
    expect(isRemoteConfigSpec('/absolute/path/config.yml')).toBe(false);
    expect(isRemoteConfigSpec('./relative/config.yml')).toBe(false);
    expect(isRemoteConfigSpec('config.yml')).toBe(false);
  });
});

describe('remote config spec parsing', () => {
  it('throws on github: spec missing file separator', async () => {
    await expect(loadConfig('github:owner/repo')).rejects.toThrow(
      'Invalid github config spec',
    );
  });

  it('throws on github: spec with empty repo', async () => {
    await expect(loadConfig('github::path/to/file.yml')).rejects.toThrow(
      'Invalid github config spec',
    );
  });

  it('throws on github: spec with empty file', async () => {
    await expect(loadConfig('github:owner/repo:')).rejects.toThrow(
      'Invalid github config spec',
    );
  });

  it('throws on gitlab: spec missing file separator', async () => {
    await expect(loadConfig('gitlab:group/project')).rejects.toThrow(
      'Invalid gitlab config spec',
    );
  });

  it('throws on gitlab: spec with empty project', async () => {
    await expect(loadConfig('gitlab::path/to/file.yml')).rejects.toThrow(
      'Invalid gitlab config spec',
    );
  });

  it('throws on gitlab: spec with empty file', async () => {
    await expect(loadConfig('gitlab:group/project:')).rejects.toThrow(
      'Invalid gitlab config spec',
    );
  });
});

describe('loadConfig', () => {
  it('loads a valid http src', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.files).toHaveLength(1);
    expect(cfg.files[0].src).toBe('https://example.com/foo.txt');
    expect(cfg.files[0].target).toBe('foo.txt');
  });

  it('loads a local path src', async () => {
    const f = writeTmp(`
files:
  - src: ~/some/file.sh
    target: file.sh
    mode: "0777"
`);
    const cfg = await loadConfig(f);
    expect(cfg.files[0].src).toBe('~/some/file.sh');
    expect(cfg.files[0].mode).toBe('0777');
  });

  it('loads an exec src map', async () => {
    const f = writeTmp(`
files:
  - src:
      exec: echo hello
    target: out.txt
`);
    const cfg = await loadConfig(f);
    const src = cfg.files[0].src;
    expect(typeof src).toBe('object');
    expect(src).toHaveProperty('exec', 'echo hello');
  });

  it('loads a gitlab src map', async () => {
    const f = writeTmp(`
files:
  - src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: \$latest
`);
    const cfg = await loadConfig(f);
    const src = cfg.files[0].src as {
      gitlab: { project: string; file: string; ref: string };
    };
    expect(src.gitlab.project).toBe('group/project');
    expect(src.gitlab.file).toBe('renovate.json');
    expect(src.gitlab.ref).toBe('$latest');
    expect(cfg.files[0].target).toBeUndefined();
  });

  it('loads a github src map', async () => {
    const f = writeTmp(`
files:
  - src:
      github:
        repo: org/repo
        file: scripts/
        ref: main
    target: local-scripts/
`);
    const cfg = await loadConfig(f);
    const src = cfg.files[0].src as {
      github: { repo: string; file: string; ref: string };
    };
    expect(src.github.repo).toBe('org/repo');
    expect(src.github.file).toBe('scripts/');
    expect(src.github.ref).toBe('main');
    expect(cfg.files[0].target).toBe('local-scripts/');
  });

  it('throws if config file not found', async () => {
    await expect(loadConfig('/nonexistent/path.yml')).rejects.toThrow(
      'Config file not found',
    );
  });

  it('throws on bad YAML', async () => {
    const f = writeTmp('files: [unclosed');
    await expect(loadConfig(f)).rejects.toThrow('Failed to parse config file');
  });

  it('throws if files is missing', async () => {
    const f = writeTmp('foo: bar\n');
    await expect(loadConfig(f)).rejects.toThrow('"files" array');
  });

  it('throws if src is missing', async () => {
    const f = writeTmp('files:\n  - target: foo.txt\n');
    await expect(loadConfig(f)).rejects.toThrow('"src" is required');
  });

  it('throws if exec src has no target', async () => {
    const f = writeTmp(`
files:
  - src:
      exec: echo hello
`);
    await expect(loadConfig(f)).rejects.toThrow(
      '"target" is required for exec/raw sources',
    );
  });

  it('throws if gitlab src missing project', async () => {
    const f = writeTmp(`
files:
  - src:
      gitlab:
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('gitlab.project');
  });

  it('throws if github src missing repo', async () => {
    const f = writeTmp(`
files:
  - src:
      github:
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('github.repo');
  });

  it('loads replace rules', async () => {
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
    const cfg = await loadConfig(f);
    expect(cfg.files[0].replace).toEqual([
      { from: '{EMAIL}', to: 'deemes79@googlemail.com' },
      { from: '/\\d+/', to: 'number' },
    ]);
  });

  it('loads post field', async () => {
    const f = writeTmp(`
files:
  - src:
      exec: glab api "projects/foo/bar"
    target: out.yml
    post: "sed -e 's/v3/v4/g'"
`);
    const cfg = await loadConfig(f);
    expect(cfg.files[0].post).toBe("sed -e 's/v3/v4/g'");
  });

  // ── multi-source ──────────────────────────────────────────────────────────

  it('loads a list src with mixed types', async () => {
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
    const cfg = await loadConfig(f);
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

  it('throws when list src has no target', async () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/a.txt
      - https://example.com/b.txt
`);
    await expect(loadConfig(f)).rejects.toThrow(
      /"target" is required when "src" is a list/,
    );
  });

  it('reports correct index in error for invalid list src item', async () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/a.txt
      - 42
    target: out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow(/files\[0\]\.src\[1\]/);
  });

  // ── variables ─────────────────────────────────────────────────────────────

  it('loads a variables block', async () => {
    const f = writeTmp(`
variables:
  email: you@example.com
  version: "1.2.3"
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables).toEqual({
      email: 'you@example.com',
      version: '1.2.3',
    });
  });

  it('returns empty variables when block is absent', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables).toEqual({});
  });

  it('throws when variables block is not a map', async () => {
    const f = writeTmp(`
variables:
  - email
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('"variables" must be a map');
  });

  it('throws when a variable value is not a string', async () => {
    const f = writeTmp(`
variables:
  count: 42
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'variables.count: value must be a string',
    );
  });

  it('throws when a reserved variable name is used', async () => {
    const f = writeTmp(`
variables:
  latest: "1.0.0"
files:
  - src: https://example.com/foo.txt
    target: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('"latest" is reserved');
  });

  // ── json ──────────────────────────────────────────────────────────────────

  it('loads an empty json block', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json: {}
`);
    const cfg = await loadConfig(f);
    expect(cfg.files[0].json).toEqual({});
  });

  it('loads json block with all options', async () => {
    const f = writeTmp(`
files:
  - src:
      - https://example.com/a.json
      - https://example.com/b.json
    target: merged.json
    json:
      conflicts: first_wins
      arrays: concat
      objects: replace
`);
    const cfg = await loadConfig(f);
    expect(cfg.files[0].json).toEqual({
      conflicts: 'first_wins',
      arrays: 'concat',
      objects: 'replace',
    });
  });

  it('throws on invalid conflicts value', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json:
      conflicts: overwrite
`);
    await expect(loadConfig(f)).rejects.toThrow('json.conflicts');
  });

  it('throws on invalid arrays value', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json:
      arrays: append
`);
    await expect(loadConfig(f)).rejects.toThrow('json.arrays');
  });

  it('throws on invalid objects value', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json:
      objects: deep
`);
    await expect(loadConfig(f)).rejects.toThrow('json.objects');
  });

  it('accepts json: true', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json: true
`);
    const config = await loadConfig(f);
    expect(config.files[0].json).toBe(true);
  });

  it('accepts json: false', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json: false
`);
    const config = await loadConfig(f);
    expect(config.files[0].json).toBe(false);
  });

  it('throws when json is not an object, boolean, or null', async () => {
    const f = writeTmp(`
files:
  - src: https://example.com/foo.json
    target: foo.json
    json: "invalid"
`);
    await expect(loadConfig(f)).rejects.toThrow('"json" must be an object');
  });
});
