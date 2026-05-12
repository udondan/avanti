import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadConfig,
  isRemoteConfigSpec,
  normalizeConfigKey,
  parseConfigContent,
  resolveConfigPath,
  SELF_KEY,
} from '../src/config';
import { parseGitRemoteSpec } from '../src/sources/git';

function writeTmp(content: string): string {
  const f = path.join(os.tmpdir(), `avanti-test-${Date.now()}.yml`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

describe('normalizeConfigKey', () => {
  it('strips @ref from github: specs', () => {
    expect(normalizeConfigKey('github:owner/repo:config.yml@main')).toBe(
      'github:owner/repo:config.yml',
    );
  });

  it('strips @ref from gitlab: specs', () => {
    expect(normalizeConfigKey('gitlab:group/project:config.yml@v1.2.3')).toBe(
      'gitlab:group/project:config.yml',
    );
  });

  it('leaves github: specs without a ref unchanged', () => {
    expect(normalizeConfigKey('github:owner/repo:config.yml')).toBe(
      'github:owner/repo:config.yml',
    );
  });

  it('leaves https URLs unchanged', () => {
    expect(normalizeConfigKey('https://example.com/config.yml')).toBe(
      'https://example.com/config.yml',
    );
  });

  it('leaves local paths unchanged', () => {
    expect(normalizeConfigKey('/absolute/path/config.yml')).toBe(
      '/absolute/path/config.yml',
    );
  });

  it('strips @ref from git+ssh:// specs without affecting @host', () => {
    expect(
      normalizeConfigKey('git+ssh://git@host/org/repo.git//avanti.yml@main'),
    ).toBe('git+ssh://git@host/org/repo.git//avanti.yml');
  });

  it('leaves git+ssh:// specs without a ref unchanged', () => {
    expect(
      normalizeConfigKey('git+ssh://git@host/org/repo.git//avanti.yml'),
    ).toBe('git+ssh://git@host/org/repo.git//avanti.yml');
  });
});

describe('parseGitRemoteSpec', () => {
  it('parses a full spec with ref', () => {
    expect(
      parseGitRemoteSpec(
        'git+ssh://git@host/org/repo.git//path/to/file.yml@main',
      ),
    ).toEqual({
      repo: 'git+ssh://git@host/org/repo.git',
      file: 'path/to/file.yml',
      ref: 'main',
    });
  });

  it('parses a spec without ref', () => {
    expect(
      parseGitRemoteSpec('git+ssh://git@host/org/repo.git//avanti.yml'),
    ).toEqual({
      repo: 'git+ssh://git@host/org/repo.git',
      file: 'avanti.yml',
      ref: undefined,
    });
  });

  it('parses a git:// spec', () => {
    expect(
      parseGitRemoteSpec('git://host/repo.git//config.yml@v1.2.3'),
    ).toEqual({
      repo: 'git://host/repo.git',
      file: 'config.yml',
      ref: 'v1.2.3',
    });
  });

  it('throws when // separator is missing', () => {
    expect(() => parseGitRemoteSpec('git+ssh://git@host/org/repo.git')).toThrow(
      'Invalid git URL spec',
    );
  });

  it('throws when repo part is empty (// immediately after scheme)', () => {
    expect(() => parseGitRemoteSpec('git+ssh:////file.yml')).toThrow(
      'Invalid git URL spec',
    );
  });

  it('throws when file path after // is empty', () => {
    expect(() =>
      parseGitRemoteSpec('git+ssh://git@host/org/repo.git//@main'),
    ).toThrow('File path is required');
  });
});

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

  it('detects git+ssh:// URLs', () => {
    expect(
      isRemoteConfigSpec('git+ssh://git@host/org/repo.git//avanti.yml'),
    ).toBe(true);
  });

  it('detects git:// URLs', () => {
    expect(isRemoteConfigSpec('git://host/repo.git//avanti.yml')).toBe(true);
  });

  it('detects ssh:// URLs', () => {
    expect(isRemoteConfigSpec('ssh://git@host/repo.git//avanti.yml')).toBe(
      true,
    );
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
  foo.txt:
    src: https://example.com/foo.txt
`);
    const cfg = await loadConfig(f);
    expect(Object.keys(cfg.files)).toHaveLength(1);
    expect(cfg.files['foo.txt'].src).toBe('https://example.com/foo.txt');
    expect(cfg.files['foo.txt'].target).toBe('foo.txt');
  });

  it('loads a local path src', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: "0777"
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['file.sh'].src).toBe('~/some/file.sh');
    expect(cfg.files['file.sh'].mode).toBe('0777');
  });

  it('loads an exec src map', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hello
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src;
    expect(typeof src).toBe('object');
    expect(src).toHaveProperty('exec', 'echo hello');
  });

  it('loads a gitlab src map', async () => {
    const f = writeTmp(`
files:
  renovate.json:
    src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: $latest
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['renovate.json'].src as {
      gitlab: { project: string; file: string; ref: string };
    };
    expect(src.gitlab.project).toBe('group/project');
    expect(src.gitlab.file).toBe('renovate.json');
    expect(src.gitlab.ref).toBe('$latest');
    expect(cfg.files['renovate.json'].target).toBe('renovate.json');
  });

  it('loads a github src map', async () => {
    const f = writeTmp(`
files:
  local-scripts/:
    src:
      github:
        repo: org/repo
        file: scripts/
        ref: main
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['local-scripts/'].src as {
      github: { repo: string; file: string; ref: string };
    };
    expect(src.github.repo).toBe('org/repo');
    expect(src.github.file).toBe('scripts/');
    expect(src.github.ref).toBe('main');
    expect(cfg.files['local-scripts/'].target).toBe('local-scripts/');
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
    await expect(loadConfig(f)).rejects.toThrow('"files" map');
  });

  it('throws if files is a list', async () => {
    const f = writeTmp('files:\n  - src: foo.txt\n');
    await expect(loadConfig(f)).rejects.toThrow('"files" map');
  });

  it('throws if src is missing', async () => {
    const f = writeTmp('files:\n  foo.txt:\n    mode: "0644"\n');
    await expect(loadConfig(f)).rejects.toThrow('"src" is required');
  });

  it('throws if gitlab src missing project', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      gitlab:
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('gitlab.project');
  });

  it('throws if github src missing repo', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      github:
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('github.repo');
  });

  it('loads a bitbucket src map', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      bitbucket:
        workspace: my-workspace
        repo: my-repo
        file: path/to/file.txt
        ref: main
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['file.txt'].src as {
      bitbucket: {
        workspace: string;
        repo: string;
        file: string;
        ref: string;
      };
    };
    expect(src.bitbucket.workspace).toBe('my-workspace');
    expect(src.bitbucket.repo).toBe('my-repo');
    expect(src.bitbucket.file).toBe('path/to/file.txt');
    expect(src.bitbucket.ref).toBe('main');
  });

  it('loads a bitbucket src map without ref', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      bitbucket:
        workspace: acme
        repo: shared
        file: config.yml
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['config.yml'].src as {
      bitbucket: {
        workspace: string;
        repo: string;
        file: string;
        ref?: string;
      };
    };
    expect(src.bitbucket.workspace).toBe('acme');
    expect(src.bitbucket.ref).toBeUndefined();
  });

  it('throws if bitbucket src missing workspace', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      bitbucket:
        repo: my-repo
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('bitbucket.workspace');
  });

  it('throws if bitbucket src missing repo', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      bitbucket:
        workspace: acme
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('bitbucket.repo');
  });

  it('throws if bitbucket src missing file', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      bitbucket:
        workspace: acme
        repo: my-repo
`);
    await expect(loadConfig(f)).rejects.toThrow('bitbucket.file');
  });

  it('loads a gitlab src with host', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      gitlab:
        project: group/project
        file: file.txt
        host: gitlab.mycompany.com
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['file.txt'].src as {
      gitlab: { project: string; file: string; host: string };
    };
    expect(src.gitlab.host).toBe('gitlab.mycompany.com');
  });

  it('loads a github src with host', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        host: github.mycompany.com
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['file.txt'].src as {
      github: { repo: string; file: string; host: string };
    };
    expect(src.github.host).toBe('github.mycompany.com');
  });

  it('loads a bitbucket src with host', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      bitbucket:
        workspace: acme
        repo: shared
        file: file.txt
        host: bitbucket.mycompany.com
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['file.txt'].src as {
      bitbucket: {
        workspace: string;
        repo: string;
        file: string;
        host: string;
      };
    };
    expect(src.bitbucket.host).toBe('bitbucket.mycompany.com');
  });

  it('throws if gitlab host is an empty string', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      gitlab:
        project: group/project
        file: file.txt
        host: ""
`);
    await expect(loadConfig(f)).rejects.toThrow('gitlab.host');
  });

  it('throws if github host is an empty string', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        host: ""
`);
    await expect(loadConfig(f)).rejects.toThrow('github.host');
  });

  it('throws if bitbucket host is an empty string', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      bitbucket:
        workspace: acme
        repo: shared
        file: file.txt
        host: ""
`);
    await expect(loadConfig(f)).rejects.toThrow('bitbucket.host');
  });

  it('throws if gitlab host is whitespace-only', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      gitlab:
        project: group/project
        file: file.txt
        host: "   "
`);
    await expect(loadConfig(f)).rejects.toThrow('gitlab.host');
  });

  it('throws if github host is whitespace-only', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        host: "   "
`);
    await expect(loadConfig(f)).rejects.toThrow('github.host');
  });

  it('throws if bitbucket host is whitespace-only', async () => {
    const f = writeTmp(`
files:
  file.txt:
    src:
      bitbucket:
        workspace: acme
        repo: shared
        file: file.txt
        host: "   "
`);
    await expect(loadConfig(f)).rejects.toThrow('bitbucket.host');
  });

  it('loads a git src map', async () => {
    const f = writeTmp(`
files:
  deploy.sh:
    src:
      git:
        repo: https://github.com/org/repo.git
        file: scripts/deploy.sh
        ref: v1.2.3
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['deploy.sh'].src as {
      git: { repo: string; file: string; ref: string };
    };
    expect(src.git.repo).toBe('https://github.com/org/repo.git');
    expect(src.git.file).toBe('scripts/deploy.sh');
    expect(src.git.ref).toBe('v1.2.3');
  });

  it('loads a git src map without ref', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      git:
        repo: git@github.com:org/repo.git
        file: config.yml
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['config.yml'].src as {
      git: { repo: string; file: string; ref?: string };
    };
    expect(src.git.repo).toBe('git@github.com:org/repo.git');
    expect(src.git.ref).toBeUndefined();
  });

  it('throws if git src missing repo', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      git:
        file: foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('git.repo');
  });

  it('throws if git src missing file', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src:
      git:
        repo: https://github.com/org/repo.git
`);
    await expect(loadConfig(f)).rejects.toThrow('git.file');
  });

  it('loads an s3 src', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      s3: s3://my-bucket/path/to/config.yml
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['config.yml'].src as { s3: string };
    expect(src.s3).toBe('s3://my-bucket/path/to/config.yml');
  });

  it('throws if s3 src is not a string', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      s3:
        bucket: my-bucket
`);
    await expect(loadConfig(f)).rejects.toThrow('s3:');
  });

  it('loads a vault src map', async () => {
    const f = writeTmp(`
files:
  db_password.txt:
    src:
      vault:
        path: secret/myapp/db
        field: password
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['db_password.txt'].src as {
      vault: { path: string; field: string };
    };
    expect(src.vault.path).toBe('secret/myapp/db');
    expect(src.vault.field).toBe('password');
  });

  it('loads a vault src map without field', async () => {
    const f = writeTmp(`
files:
  config.json:
    src:
      vault:
        path: secret/myapp/config
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['config.json'].src as {
      vault: { path: string; field?: string };
    };
    expect(src.vault.path).toBe('secret/myapp/config');
    expect(src.vault.field).toBeUndefined();
  });

  it('throws if vault src missing path', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      vault:
        field: password
`);
    await expect(loadConfig(f)).rejects.toThrow('vault.path');
  });

  it('loads replace rules', async () => {
    const f = writeTmp(`
files:
  foo.txt:
    src: https://example.com/foo.txt
    replace:
      - from: "{EMAIL}"
        to: deemes79@googlemail.com
      - from: /\\d+/
        to: number
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['foo.txt'].replace).toEqual([
      { from: '{EMAIL}', to: 'deemes79@googlemail.com' },
      { from: '/\\d+/', to: 'number' },
    ]);
  });

  it('loads post field', async () => {
    const f = writeTmp(`
files:
  out.yml:
    src:
      exec: glab api "projects/foo/bar"
    post: "sed -e 's/v3/v4/g'"
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['out.yml'].post).toBe("sed -e 's/v3/v4/g'");
  });

  // ── multi-source ──────────────────────────────────────────────────────────

  it('loads a list src with mixed types', async () => {
    const f = writeTmp(`
files:
  combined.txt:
    src:
      - https://example.com/header.txt
      - exec: echo "middle"
      - gitlab:
          project: org/repo
          file: footer.txt
          ref: main
`);
    const cfg = await loadConfig(f);
    const entry = cfg.files['combined.txt'];
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

  it('reports correct target key in error for invalid list src item', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      - https://example.com/a.txt
      - 42
`);
    await expect(loadConfig(f)).rejects.toThrow(
      /files\["out\.txt"\]\.src\[1\]/,
    );
  });

  // ── variables ─────────────────────────────────────────────────────────────

  it('loads a variables block', async () => {
    const f = writeTmp(`
variables:
  email: you@example.com
  version: "1.2.3"
files:
  foo.txt:
    src: https://example.com/foo.txt
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
  foo.txt:
    src: https://example.com/foo.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables).toEqual({});
  });

  it('throws when variables block is not a map', async () => {
    const f = writeTmp(`
variables:
  - email
files:
  foo.txt:
    src: https://example.com/foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('"variables" must be a map');
  });

  it('throws when a variable value is not a string', async () => {
    const f = writeTmp(`
variables:
  count: 42
files:
  foo.txt:
    src: https://example.com/foo.txt
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
  foo.txt:
    src: https://example.com/foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('"latest" is reserved');
  });

  // ── json ──────────────────────────────────────────────────────────────────

  it('loads an empty json block', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json: {}
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['foo.json'].json).toEqual({});
  });

  it('loads json block with all options', async () => {
    const f = writeTmp(`
files:
  merged.json:
    src:
      - https://example.com/a.json
      - https://example.com/b.json
    json:
      conflicts: first_wins
      arrays: concat
      objects: replace
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['merged.json'].json).toEqual({
      conflicts: 'first_wins',
      arrays: 'concat',
      objects: 'replace',
    });
  });

  it('throws on invalid conflicts value', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json:
      conflicts: overwrite
`);
    await expect(loadConfig(f)).rejects.toThrow('json.conflicts');
  });

  it('throws on invalid arrays value', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json:
      arrays: append
`);
    await expect(loadConfig(f)).rejects.toThrow('json.arrays');
  });

  it('throws on invalid objects value', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json:
      objects: deep
`);
    await expect(loadConfig(f)).rejects.toThrow('json.objects');
  });

  it('accepts json: true', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json: true
`);
    const config = await loadConfig(f);
    expect(config.files['foo.json'].json).toBe(true);
  });

  it('accepts json: false', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json: false
`);
    const config = await loadConfig(f);
    expect(config.files['foo.json'].json).toBe(false);
  });

  it('throws when json is not an object, boolean, or null', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json: "invalid"
`);
    await expect(loadConfig(f)).rejects.toThrow('"json" must be an object');
  });
});

describe('resolveConfigPath', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-config-test-')),
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the explicit path resolved to absolute for a local path', () => {
    const absPath = path.join(os.tmpdir(), 'path', 'config.yml');
    const result = resolveConfigPath(absPath);
    expect(result).toBe(absPath);
  });

  it('resolves a relative explicit path to an absolute path', () => {
    const result = resolveConfigPath('relative/config.yml');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith(path.join('relative', 'config.yml'))).toBe(true);
  });

  it('returns a github: spec unchanged', () => {
    const spec = 'github:owner/repo:config.yml@main';
    expect(resolveConfigPath(spec)).toBe(spec);
  });

  it('returns a gitlab: spec unchanged', () => {
    const spec = 'gitlab:group/project:config.yml@v1';
    expect(resolveConfigPath(spec)).toBe(spec);
  });

  it('returns an http:// URL unchanged', () => {
    const spec = 'http://example.com/config.yml';
    expect(resolveConfigPath(spec)).toBe(spec);
  });

  it('returns an https:// URL unchanged', () => {
    const spec = 'https://example.com/config.yml';
    expect(resolveConfigPath(spec)).toBe(spec);
  });

  it('returns a git+ssh:// spec unchanged', () => {
    const spec = 'git+ssh://git@host/org/repo.git//avanti.yml@main';
    expect(resolveConfigPath(spec)).toBe(spec);
  });

  it('auto-detects .avanti.yml in cwd when present', () => {
    fs.writeFileSync(path.join(tmpDir, '.avanti.yml'), 'files: {}', 'utf8');
    process.chdir(tmpDir);
    const result = resolveConfigPath();
    expect(result).toBe(path.join(tmpDir, '.avanti.yml'));
  });

  it('auto-detects config file case-insensitively (.AVANTI.YML)', () => {
    fs.writeFileSync(path.join(tmpDir, '.AVANTI.YML'), 'files: {}', 'utf8');
    process.chdir(tmpDir);
    const result = resolveConfigPath();
    expect(result).toBe(path.join(tmpDir, '.AVANTI.YML'));
  });

  it('auto-detects avanti.yaml when .avanti.yml is absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'avanti.yaml'), 'files: {}', 'utf8');
    process.chdir(tmpDir);
    const result = resolveConfigPath();
    expect(result).toBe(path.join(tmpDir, 'avanti.yaml'));
  });

  it('returns fallback .avanti.yml path when no config file found', () => {
    process.chdir(tmpDir);
    const result = resolveConfigPath();
    expect(result).toBe(path.join(tmpDir, '.avanti.yml'));
  });
});

// ---------------------------------------------------------------------------
// parseSha — SHA format validation in config parsing
// ---------------------------------------------------------------------------

describe('parseSha validation in config parsing', () => {
  it('accepts a valid 64-char lowercase hex SHA', async () => {
    const sha = 'a'.repeat(64);
    const f = writeTmp(`
files:
  out.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        sha: ${sha}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { github: { sha?: string } };
    expect(src.github.sha).toBe(sha);
  });

  it('normalizes uppercase SHA to lowercase', async () => {
    const sha = 'A'.repeat(64);
    const f = writeTmp(`
files:
  out.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        sha: ${sha}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { github: { sha?: string } };
    expect(src.github.sha).toBe('a'.repeat(64));
  });

  it('throws on an invalid SHA (wrong length)', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        sha: tooshort
`);
    await expect(loadConfig(f)).rejects.toThrow('expected 64 hex characters');
  });

  it('throws on an invalid SHA (non-hex chars)', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      github:
        repo: org/repo
        file: file.txt
        sha: ${'z'.repeat(64)}
`);
    await expect(loadConfig(f)).rejects.toThrow('expected 64 hex characters');
  });

  it('accepts a valid SHA on a gitlab source', async () => {
    const sha = 'b'.repeat(64);
    const f = writeTmp(`
files:
  out.txt:
    src:
      gitlab:
        project: group/proj
        file: config.yml
        sha: ${sha}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { gitlab: { sha?: string } };
    expect(src.gitlab.sha).toBe(sha);
  });
});

describe('http source parsing', () => {
  it('accepts a valid https:// URL', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      http: https://example.com/file.txt
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { http: string };
    expect(src.http).toBe('https://example.com/file.txt');
  });

  it('accepts an http source with sha and normalizes to lowercase', async () => {
    const sha = 'A'.repeat(64);
    const f = writeTmp(`
files:
  out.txt:
    src:
      http: https://example.com/file.txt
      sha: ${sha}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { http: string; sha?: string };
    expect(src.sha).toBe('a'.repeat(64));
  });

  it('throws when http value does not start with http:// or https:// (literal)', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      http: ftp://example.com/file.txt
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'must start with http:// or https://',
    );
  });

  it('accepts a variable-driven http URL without scheme validation', async () => {
    const f = writeTmp(`
variables:
  url: https://example.com/file.txt
files:
  out.txt:
    src:
      http: $url
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { http: string };
    expect(src.http).toBe('$url');
  });

  it('loads a path src map', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ~/custom.md
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { path: string };
    expect(src.path).toBe('~/custom.md');
  });

  it('loads a path src map with optional: true', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ~/custom.md
      optional: true
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { path: string; optional: boolean };
    expect(src.path).toBe('~/custom.md');
    expect(src.optional).toBe(true);
  });

  it('loads a path src map with optional: false', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ~/custom.md
      optional: false
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { path: string; optional: boolean };
    expect(src.optional).toBe(false);
  });

  it('loads a path src map with sha', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ~/custom.md
      sha: ${'a'.repeat(64)}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { path: string; sha?: string };
    expect(src.sha).toBe('a'.repeat(64));
  });

  it('throws when path value is not a string', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: 123
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'path: must be a non-empty string',
    );
  });

  it('throws when path value is empty', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ""
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'path: must be a non-empty string',
    );
  });

  it('throws when optional is not a boolean in path src', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      path: ~/custom.md
      optional: "yes"
`);
    await expect(loadConfig(f)).rejects.toThrow('optional: must be a boolean');
  });

  it('loads a url src map', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: https://example.com/file.txt
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string };
    expect(src.url).toBe('https://example.com/file.txt');
  });

  it('loads a url src map with optional: true', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: https://example.com/file.txt
      optional: true
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string; optional: boolean };
    expect(src.url).toBe('https://example.com/file.txt');
    expect(src.optional).toBe(true);
  });

  it('loads a url src map with sha', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: https://example.com/file.txt
      sha: ${'b'.repeat(64)}
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string; sha?: string };
    expect(src.sha).toBe('b'.repeat(64));
  });

  it('throws when url uses an unsupported scheme (literal)', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: ftp://example.com/file.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('must start with http://');
  });

  it('accepts a git+ssh:// url src', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: git+ssh://git@host/org/repo.git//file.txt@main
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string };
    expect(src.url).toBe('git+ssh://git@host/org/repo.git//file.txt@main');
  });

  it('accepts a git:// url src', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: git://host/repo.git//file.txt
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string };
    expect(src.url).toBe('git://host/repo.git//file.txt');
  });

  it('throws when url value is empty', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: ""
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'url: must be a non-empty string',
    );
  });

  it('throws when optional is not a boolean in url src', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: https://example.com/file.txt
      optional: 1
`);
    await expect(loadConfig(f)).rejects.toThrow('optional: must be a boolean');
  });

  it('accepts a variable-driven url without scheme validation', async () => {
    const f = writeTmp(`
variables:
  endpoint: https://example.com/file.txt
files:
  out.txt:
    src:
      url: $endpoint
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out.txt'].src as { url: string };
    expect(src.url).toBe('$endpoint');
  });
});

describe('$self key', () => {
  it('parses a config with $self key and sets target to $self', () => {
    const cfg = parseConfigContent(`
files:
  ${SELF_KEY}:
    src:
      - path: /tmp/a.yml
      - path: /tmp/b.yml
    yaml: true
`);
    expect(cfg.files[SELF_KEY]).toBeDefined();
    expect(cfg.files[SELF_KEY].target).toBe(SELF_KEY);
    expect(Array.isArray(cfg.files[SELF_KEY].src)).toBe(true);
    expect(cfg.files[SELF_KEY].yaml).toBe(true);
  });

  it('can coexist with regular file entries', () => {
    const cfg = parseConfigContent(`
files:
  ${SELF_KEY}:
    src: /tmp/base.yml
  output.txt:
    src: /tmp/source.txt
`);
    expect(Object.keys(cfg.files)).toHaveLength(2);
    expect(cfg.files[SELF_KEY]).toBeDefined();
    expect(cfg.files['output.txt']).toBeDefined();
  });
});
