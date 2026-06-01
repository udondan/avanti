import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveConfigBase,
  loadConfig,
  isRemoteConfigSpec,
  normalizeConfigKey,
  parseConfigContent,
  resolveConfigPath,
  resolveRelativeSrc,
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

describe('deriveConfigBase', () => {
  it('returns dirname for a local config path', () => {
    expect(deriveConfigBase('/home/user/configs/avanti.yml')).toBe(
      '/home/user/configs',
    );
  });

  it('returns directory portion of an HTTP config URL', () => {
    expect(deriveConfigBase('https://example.com/configs/avanti.yml')).toBe(
      'https://example.com/configs/',
    );
  });

  it('handles an HTTP config at the URL root', () => {
    expect(deriveConfigBase('https://example.com/avanti.yml')).toBe(
      'https://example.com/',
    );
  });

  it('returns directory prefix for a github: config', () => {
    expect(deriveConfigBase('github:owner/repo:configs/avanti.yml')).toBe(
      'github:owner/repo:configs',
    );
  });

  it('preserves ref in github: config base', () => {
    expect(deriveConfigBase('github:owner/repo:configs/avanti.yml@main')).toBe(
      'github:owner/repo:configs@main',
    );
  });

  it('handles github: config at repo root (no dir)', () => {
    expect(deriveConfigBase('github:owner/repo:avanti.yml')).toBe(
      'github:owner/repo:',
    );
  });

  it('returns directory prefix for a gitlab: config', () => {
    expect(deriveConfigBase('gitlab:group/project:configs/avanti.yml@v1')).toBe(
      'gitlab:group/project:configs@v1',
    );
  });
});

describe('resolveRelativeSrc', () => {
  it('resolves a relative src against a local config dir', () => {
    expect(resolveRelativeSrc('./scripts/foo.sh', '/home/user/configs')).toBe(
      '/home/user/configs/scripts/foo.sh',
    );
  });

  it('resolves a dotless relative src against a local config dir', () => {
    expect(resolveRelativeSrc('scripts/foo.sh', '/home/user/configs')).toBe(
      '/home/user/configs/scripts/foo.sh',
    );
  });

  it('resolves .. traversal in a relative src against a local config dir', () => {
    expect(resolveRelativeSrc('../sibling/foo.sh', '/home/user/configs')).toBe(
      '/home/user/sibling/foo.sh',
    );
  });

  it('leaves absolute src unchanged', () => {
    expect(resolveRelativeSrc('/abs/foo.sh', '/home/user/configs')).toBe(
      '/abs/foo.sh',
    );
  });

  it('leaves tilde-prefixed src unchanged', () => {
    expect(resolveRelativeSrc('~/foo.sh', '/home/user/configs')).toBe(
      '~/foo.sh',
    );
  });

  it('leaves an http:// src unchanged', () => {
    expect(
      resolveRelativeSrc('http://example.com/foo.sh', '/home/user/configs'),
    ).toBe('http://example.com/foo.sh');
  });

  it('leaves a github: src unchanged', () => {
    expect(
      resolveRelativeSrc('github:owner/repo:file.sh', '/home/user/configs'),
    ).toBe('github:owner/repo:file.sh');
  });

  it('resolves a relative src against an HTTP config base', () => {
    expect(
      resolveRelativeSrc('./scripts/foo.sh', 'https://example.com/configs/'),
    ).toBe('https://example.com/configs/scripts/foo.sh');
  });

  it('resolves a relative src against a github: config base', () => {
    expect(
      resolveRelativeSrc('./scripts/foo.sh', 'github:owner/repo:configs'),
    ).toBe('github:owner/repo:configs/scripts/foo.sh');
  });

  it('preserves ref when resolving against a github: config base', () => {
    expect(
      resolveRelativeSrc('./scripts/foo.sh', 'github:owner/repo:configs@main'),
    ).toBe('github:owner/repo:configs/scripts/foo.sh@main');
  });

  it('resolves a relative src from the root of a github: repo', () => {
    expect(resolveRelativeSrc('./foo.sh', 'github:owner/repo:')).toBe(
      'github:owner/repo:foo.sh',
    );
  });

  it('resolves a relative src against a gitlab: config base', () => {
    expect(
      resolveRelativeSrc('./scripts/foo.sh', 'gitlab:group/project:configs@v1'),
    ).toBe('gitlab:group/project:configs/scripts/foo.sh@v1');
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

  it('throws on non-scheme input (no :// present)', () => {
    expect(() => parseGitRemoteSpec('git@host/repo.git//file.yml')).toThrow(
      'Invalid git URL spec',
    );
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

  it('accepts a numeric mode from YAML 0o-notation 0o755 (493 → "0755")', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: 0o755
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['file.sh'].mode).toBe('0755');
  });

  it('accepts a numeric mode from YAML 0o-notation 0o644 (→ "0644")', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: 0o644
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['file.sh'].mode).toBe('0644');
  });

  it('rejects a bare decimal like 755', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: 755
`);
    await expect(loadConfig(f)).rejects.toThrow(/bare decimal/);
  });

  it('rejects an invalid string mode', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: garbage
`);
    await expect(loadConfig(f)).rejects.toThrow(/not a valid octal string/);
  });

  it('rejects a string mode with non-octal digits', async () => {
    const f = writeTmp(`
files:
  file.sh:
    src: ~/some/file.sh
    mode: "0o755"
`);
    await expect(loadConfig(f)).rejects.toThrow(/not a valid octal string/);
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

  it('loads an aws_s3 src', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      aws_s3: s3://my-bucket/path/to/config.yml
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['config.yml'].src as { aws_s3: string };
    expect(src.aws_s3).toBe('s3://my-bucket/path/to/config.yml');
  });

  it('throws if aws_s3 src is not a string', async () => {
    const f = writeTmp(`
files:
  config.yml:
    src:
      aws_s3:
        bucket: my-bucket
`);
    await expect(loadConfig(f)).rejects.toThrow('aws_s3:');
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

  it('loads an aws_secrets_manager src', async () => {
    const f = writeTmp(`
files:
  secret.txt:
    src:
      aws_secrets_manager:
        name: myapp/prod/db
        key: password
        region: us-east-1
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['secret.txt'].src as {
      aws_secrets_manager: { name: string; key?: string; region?: string };
    };
    expect(src.aws_secrets_manager.name).toBe('myapp/prod/db');
    expect(src.aws_secrets_manager.key).toBe('password');
    expect(src.aws_secrets_manager.region).toBe('us-east-1');
  });

  it('loads an aws_secrets_manager src without optional fields', async () => {
    const f = writeTmp(`
files:
  secret.txt:
    src:
      aws_secrets_manager:
        name: myapp/prod/db
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['secret.txt'].src as {
      aws_secrets_manager: { name: string; key?: string; region?: string };
    };
    expect(src.aws_secrets_manager.name).toBe('myapp/prod/db');
    expect(src.aws_secrets_manager.key).toBeUndefined();
    expect(src.aws_secrets_manager.region).toBeUndefined();
  });

  it('normalizes empty-string key/region to undefined for aws_secrets_manager', async () => {
    const f = writeTmp(`
files:
  secret.txt:
    src:
      aws_secrets_manager:
        name: myapp/prod/db
        key: ''
        region: ''
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['secret.txt'].src as {
      aws_secrets_manager: { name: string; key?: string; region?: string };
    };
    expect(src.aws_secrets_manager.key).toBeUndefined();
    expect(src.aws_secrets_manager.region).toBeUndefined();
  });

  it('throws if aws_secrets_manager src missing name', async () => {
    const f = writeTmp(`
files:
  secret.txt:
    src:
      aws_secrets_manager:
        key: password
`);
    await expect(loadConfig(f)).rejects.toThrow('aws_secrets_manager.name');
  });

  it('throws if aws_secrets_manager src is not an object', async () => {
    const f = writeTmp(`
files:
  secret.txt:
    src:
      aws_secrets_manager: plain-string
`);
    await expect(loadConfig(f)).rejects.toThrow('aws_secrets_manager');
  });

  it('loads an aws_systems_manager_parameter src', async () => {
    const f = writeTmp(`
files:
  param.txt:
    src:
      aws_systems_manager_parameter:
        name: /myapp/prod/host
        region: eu-west-1
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['param.txt'].src as {
      aws_systems_manager_parameter: { name: string; region?: string };
    };
    expect(src.aws_systems_manager_parameter.name).toBe('/myapp/prod/host');
    expect(src.aws_systems_manager_parameter.region).toBe('eu-west-1');
  });

  it('normalizes empty-string region to undefined for aws_systems_manager_parameter', async () => {
    const f = writeTmp(`
files:
  param.txt:
    src:
      aws_systems_manager_parameter:
        name: /myapp/prod/host
        region: ''
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['param.txt'].src as {
      aws_systems_manager_parameter: { name: string; region?: string };
    };
    expect(src.aws_systems_manager_parameter.region).toBeUndefined();
  });

  it('throws if aws_systems_manager_parameter src missing name', async () => {
    const f = writeTmp(`
files:
  param.txt:
    src:
      aws_systems_manager_parameter:
        region: us-east-1
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'aws_systems_manager_parameter.name',
    );
  });

  it('throws if aws_systems_manager_parameter src is not an object', async () => {
    const f = writeTmp(`
files:
  param.txt:
    src:
      aws_systems_manager_parameter: plain-string
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'aws_systems_manager_parameter',
    );
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

  it('loads on.write field', async () => {
    const f = writeTmp(`
files:
  out.yml:
    src:
      exec: glab api "projects/foo/bar"
    on:
      write: "sed -e 's/v3/v4/g'"
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['out.yml'].on?.write).toBe("sed -e 's/v3/v4/g'");
  });

  it('loads all on: hooks', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hello
    on:
      write: cat
      beforeWrite: echo before
      beforeCreate: echo beforeCreate
      beforeUpdate: echo beforeUpdate
      create: echo created
      update: echo updated
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['out.txt'].on).toMatchObject({
      write: 'cat',
      beforeWrite: 'echo before',
      beforeCreate: 'echo beforeCreate',
      beforeUpdate: 'echo beforeUpdate',
      create: 'echo created',
      update: 'echo updated',
    });
  });

  it('rejects unknown on: key', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hi
    on:
      unknown: echo nope
`);
    await expect(loadConfig(f)).rejects.toThrow('unknown key "unknown"');
  });

  it('rejects non-string on: value', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hi
    on:
      write: 42
`);
    await expect(loadConfig(f)).rejects.toThrow('on.write: must be a string');
  });

  it('rejects non-object on: value', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hi
    on: "not an object"
`);
    await expect(loadConfig(f)).rejects.toThrow('on: must be a mapping');
  });

  it('rejects legacy post: field with migration hint', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      exec: echo hi
    post: cat
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'post: removed — use on.write instead',
    );
  });

  it('loads strategy: insert', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    strategy: insert
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['foo.json'].strategy).toBe('insert');
  });

  it('loads strategy: replace', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    strategy: replace
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['foo.json'].strategy).toBe('replace');
  });

  it('rejects unknown strategy values', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    strategy: overwrite
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'strategy: must be "replace" or "insert"',
    );
  });

  // ── template ──────────────────────────────────────────────────────────────

  it('loads template: handlebars', async () => {
    const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template.hbs
    template: handlebars
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['output.txt'].template).toBe('handlebars');
  });

  it('loads template: true', async () => {
    const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template.hbs
    template: true
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['output.txt'].template).toBe(true);
  });

  it('loads template: jinja2 (alias preserved at parse time)', async () => {
    const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template.j2
    template: jinja2
`);
    const cfg = await loadConfig(f);
    expect(cfg.files['output.txt'].template).toBe('jinja2');
  });

  it('loads all supported template engines', async () => {
    for (const engine of [
      'handlebars',
      'nunjucks',
      'jinja2',
      'liquidjs',
      'ejs',
      'mustache',
      'eta',
    ]) {
      const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template
    template: ${engine}
`);
      const cfg = await loadConfig(f);
      expect(cfg.files['output.txt'].template).toBe(engine);
    }
  });

  it('rejects unknown template engine names', async () => {
    const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template
    template: pug
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'files["output.txt"].template: must be true or one of',
    );
  });

  it('rejects non-string, non-true template value', async () => {
    const f = writeTmp(`
files:
  output.txt:
    src: https://example.com/template
    template: 123
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'files["output.txt"].template: must be true or one of',
    );
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

  it('throws when a variable value is null', async () => {
    const f = writeTmp(`
variables:
  count: ~
files:
  foo.txt:
    src: https://example.com/foo.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.count:');
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

  it('throws on unknown json option key', async () => {
    const f = writeTmp(`
files:
  foo.json:
    src: https://example.com/foo.json
    json:
      array: concat
`);
    await expect(loadConfig(f)).rejects.toThrow('json.array: unknown option');
  });

  it('throws on unknown yaml option key', async () => {
    const f = writeTmp(`
files:
  foo.yaml:
    src: https://example.com/foo.yaml
    yaml:
      arrays: concat
      unknown_key: true
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'yaml.unknown_key: unknown option',
    );
  });

  it('throws on unknown toml option key', async () => {
    const f = writeTmp(`
files:
  foo.toml:
    src: https://example.com/foo.toml
    toml:
      arrays: concat
      unknown_key: true
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'toml.unknown_key: unknown option',
    );
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

  it('throws when git remote url is missing // file separator', async () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      url: git+ssh://git@host/org/repo.git
`);
    await expect(loadConfig(f)).rejects.toThrow('Invalid git URL spec');
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

describe('parseVia validation in config parsing', () => {
  it('accepts via: cli as a string on gitlab', () => {
    const cfg = parseConfigContent(`
files:
  out.txt:
    src:
      gitlab:
        project: group/proj
        file: file.txt
        via: cli
`);
    const src = cfg.files['out.txt'].src as { gitlab: { via?: unknown } };
    expect(src.gitlab.via).toBe('cli');
  });

  it('accepts via: [cli, api] as an array on github', () => {
    const cfg = parseConfigContent(`
files:
  out.txt:
    src:
      github:
        repo: owner/repo
        file: file.txt
        via: [cli, api]
`);
    const src = cfg.files['out.txt'].src as { github: { via?: unknown } };
    expect(src.github.via).toEqual(['cli', 'api']);
  });

  it('throws on an invalid via string', () => {
    expect(() =>
      parseConfigContent(`
files:
  out.txt:
    src:
      gitlab:
        project: group/proj
        file: file.txt
        via: ftp
`),
    ).toThrow('via: must be "api" or "cli"');
  });

  it('throws on an empty via array', () => {
    expect(() =>
      parseConfigContent(`
files:
  out.txt:
    src:
      github:
        repo: owner/repo
        file: file.txt
        via: []
`),
    ).toThrow('via: array must not be empty');
  });

  it('throws on an invalid value inside via array', () => {
    expect(() =>
      parseConfigContent(`
files:
  out.txt:
    src:
      gitlab:
        project: group/proj
        file: file.txt
        via: [cli, ftp]
`),
    ).toThrow('via[1]: must be "api" or "cli"');
  });

  it('throws on a via array with duplicate values', () => {
    expect(() =>
      parseConfigContent(`
files:
  out.txt:
    src:
      gitlab:
        project: group/proj
        file: file.txt
        via: [api, api]
`),
    ).toThrow('via[1]: duplicate value "api"');
  });

  it('throws on a via array longer than 2', () => {
    expect(() =>
      parseConfigContent(`
files:
  out.txt:
    src:
      github:
        repo: owner/repo
        file: file.txt
        via: [api, cli, api]
`),
    ).toThrow('via: array must not have more than 2 entries');
  });
});

describe('source-based variable parsing', () => {
  it('parses a variable with a raw src', async () => {
    const f = writeTmp(`
variables:
  token:
    src:
      raw: my-secret
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    const tokenVar = cfg.variables?.['token'];
    expect(tokenVar).toBeDefined();
    expect(typeof tokenVar).toBe('object');
    expect(tokenVar).toHaveProperty('src');
    const varEntry = tokenVar as { src: { raw: string } };
    expect(varEntry.src).toEqual({ raw: 'my-secret' });
  });

  it('parses a variable with an array src', async () => {
    const f = writeTmp(`
variables:
  token:
    src:
      - raw: part-a
      - raw: part-b
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    const tokenVar = cfg.variables?.['token'];
    expect(Array.isArray((tokenVar as { src: unknown }).src)).toBe(true);
  });

  it('parses a variable with an aws_secrets_manager src', async () => {
    const f = writeTmp(`
variables:
  auth_token:
    src:
      aws_secrets_manager:
        name: my-artifactory-token
        region: us-east-1
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    const varEntry = cfg.variables?.['auth_token'] as {
      src: { aws_secrets_manager: { name: string; region?: string } };
    };
    expect(varEntry.src.aws_secrets_manager.name).toBe('my-artifactory-token');
    expect(varEntry.src.aws_secrets_manager.region).toBe('us-east-1');
  });

  it('parses a variable with json merge option', async () => {
    const f = writeTmp(`
variables:
  merged:
    src:
      - raw: '{"a":1}'
      - raw: '{"b":2}'
    json:
      conflicts: last_wins
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    const varEntry = cfg.variables?.['merged'] as {
      json: { conflicts: string };
    };
    expect(varEntry.json?.conflicts).toBe('last_wins');
  });

  it('mixes plain string and source-based variables', async () => {
    const f = writeTmp(`
variables:
  plain: hello
  sourced:
    src:
      raw: world
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['plain']).toBe('hello');
    expect(typeof cfg.variables?.['sourced']).toBe('object');
  });

  it('parses a plain object variable (no src)', async () => {
    const f = writeTmp(`
variables:
  server:
    host: pg.internal
    port: 5432
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['server']).toEqual({
      host: 'pg.internal',
      port: 5432,
    });
  });

  it('parses a plain list variable', async () => {
    const f = writeTmp(`
variables:
  envs:
    - staging
    - production
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['envs']).toEqual(['staging', 'production']);
  });

  it('parses a nested object variable', async () => {
    const f = writeTmp(`
variables:
  db:
    host: pg.internal
    creds:
      user: admin
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['db']).toEqual({
      host: 'pg.internal',
      creds: { user: 'admin' },
    });
  });

  it('parses a number variable', async () => {
    const f = writeTmp(`
variables:
  port: 5432
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['port']).toBe(5432);
  });

  it('parses a boolean variable', async () => {
    const f = writeTmp(`
variables:
  tls: true
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect(cfg.variables?.['tls']).toBe(true);
  });

  it('throws when a variable value is null', async () => {
    const f = writeTmp(`
variables:
  bad: ~
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.bad:');
  });

  it('throws when a variable value is a non-plain object (e.g. YAML timestamp)', async () => {
    // js-yaml parses unquoted timestamps as Date objects; avanti must reject them
    const f = writeTmp(`
variables:
  ts: 2024-01-15T10:30:00Z
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.ts:');
  });

  it('throws when a nested value inside a list variable is a non-plain object', async () => {
    const f = writeTmp(`
variables:
  items:
    - value: 2024-01-15T10:30:00Z
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.items[0].value:');
  });

  it('throws when a nested value inside an object variable is a non-plain object', async () => {
    const f = writeTmp(`
variables:
  db:
    host: pg.internal
    updated_at: 2024-01-15T10:30:00Z
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.db.updated_at:');
  });

  it('uses variables. prefix in error messages for variable source parsing', async () => {
    const f = writeTmp(`
variables:
  token:
    src:
      aws_secrets_manager:
        region: us-east-1
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('variables.token');
  });

  it('loads template: handlebars on a source variable', async () => {
    const f = writeTmp(`
variables:
  ver:
    src: https://example.com/ver.hbs
    template: handlebars
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect((cfg.variables!['ver'] as { template: string }).template).toBe(
      'handlebars',
    );
  });

  it('loads template: true on a source variable', async () => {
    const f = writeTmp(`
variables:
  ver:
    src: https://example.com/ver.hbs
    template: true
files:
  out.txt:
    src: https://example.com/out.txt
`);
    const cfg = await loadConfig(f);
    expect((cfg.variables!['ver'] as { template: boolean }).template).toBe(
      true,
    );
  });

  it('rejects unknown template engine on a source variable', async () => {
    const f = writeTmp(`
variables:
  ver:
    src: https://example.com/ver.hbs
    template: pug
files:
  out.txt:
    src: https://example.com/out.txt
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'variables.ver.template: must be true or one of',
    );
  });
});

describe('if/ifAny condition parsing in config', () => {
  it('parses if as a single condition object on a file entry', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os: linux
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ os: 'linux' });
  });

  it('parses if as a list of condition objects (AND)', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      - os: linux
      - exists: /tmp
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual([
      { os: 'linux' },
      { exists: '/tmp' },
    ]);
  });

  it('parses ifAny as a list of condition objects (OR)', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    ifAny:
      - os: linux
      - os: mac
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt'].ifAny).toEqual([
      { os: 'linux' },
      { os: 'mac' },
    ]);
  });

  it('parses not: true in a condition', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os: windows
      not: true
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ os: 'windows', not: true });
  });

  it('parses os as an array', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os:
        - linux
        - mac
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ os: ['linux', 'mac'] });
  });

  it('throws on unknown key in condition', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      badkey: true
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'unknown key',
    );
  });

  it('throws on invalid os value', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os: solaris
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      '.os:',
    );
  });

  it('accepts darwin as os value', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os: darwin
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ os: 'darwin' });
  });

  it('accepts win32 as os value', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      os: win32
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ os: 'win32' });
  });

  it('throws on empty if array', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if: []
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'must not be an empty array',
    );
  });

  it('throws on empty ifAny array', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    ifAny: []
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'must not be an empty array',
    );
  });

  it('parses target_exists: true in a condition', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      target_exists: true
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ target_exists: true });
  });

  it('parses target_exists: false in a condition', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      target_exists: false
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['out.txt']['if']).toEqual({ target_exists: false });
  });

  it('throws on non-boolean target_exists', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    if:
      target_exists: 1
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'target_exists: must be a boolean',
    );
  });

  it('throws when ifAny is not an array', () => {
    const f = writeTmp(`
files:
  out.txt:
    src: https://example.com/out.txt
    ifAny:
      os: linux
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'must be an array',
    );
  });

  it('parses if on a source object within a multi-src entry', () => {
    const f = writeTmp(`
files:
  out.txt:
    src:
      - raw: "# linux\n"
        if:
          os: linux
      - raw: "# mac\n"
        if:
          os: mac
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    const srcs = cfg.files['out.txt'].src as Array<{
      raw: string;
      if?: unknown;
    }>;
    expect(srcs[0]['if']).toEqual({ os: 'linux' });
    expect(srcs[1]['if']).toEqual({ os: 'mac' });
  });
});

describe('backup field parsing', () => {
  it('parses a backup string on a file entry', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    backup: $dirname/$filename.bkp
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].backup).toBe('$dirname/$filename.bkp');
  });

  it('leaves backup undefined when not set', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].backup).toBeUndefined();
  });
});

describe('writeInPlace field parsing', () => {
  it('parses writeInPlace: true', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    writeInPlace: true
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].writeInPlace).toBe(true);
  });

  it('parses writeInPlace: false', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    writeInPlace: false
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].writeInPlace).toBe(false);
  });

  it('leaves writeInPlace undefined when not set', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].writeInPlace).toBeUndefined();
  });
});

describe('backup_roots parsing', () => {
  it('parses a list of backup_roots strings', () => {
    const f = writeTmp(`
backup_roots:
  - ~/backups
  - /mnt/nas/backups
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.backup_roots).toEqual(['~/backups', '/mnt/nas/backups']);
  });

  it('leaves backup_roots undefined when not set', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.backup_roots).toBeUndefined();
  });

  it('throws when backup_roots is not a list', () => {
    const f = writeTmp(`
backup_roots: ~/backups
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      '"backup_roots" must be a list of strings',
    );
  });

  it('throws when backup_roots contains a non-string entry', () => {
    const f = writeTmp(`
backup_roots:
  - ~/backups
  - 42
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      '"backup_roots" must be a list of strings',
    );
  });
});

describe('brace expansion in files keys', () => {
  it('expands a brace group into multiple entries', () => {
    const f = writeTmp(`
files:
  some/path/{foo,bar}:
    src: https://example.com/file
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(Object.keys(config.files).sort()).toEqual([
      'some/path/bar',
      'some/path/foo',
    ]);
  });

  it('sets the target field to the expanded path on each entry', () => {
    const f = writeTmp(`
files:
  'configs/{a,b}.yml':
    src: https://example.com/file
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(config.files['configs/a.yml'].target).toBe('configs/a.yml');
    expect(config.files['configs/b.yml'].target).toBe('configs/b.yml');
  });

  it('preserves src and other fields on each expanded entry', () => {
    const f = writeTmp(`
files:
  cfg/{dev,prod}.yml:
    src: https://example.com/file
    mode: '0600'
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(config.files['cfg/dev.yml'].mode).toBe('0600');
    expect(config.files['cfg/prod.yml'].mode).toBe('0600');
  });

  it('throws on duplicate: explicit key first, brace key second — shows expanded-from', () => {
    const f = writeTmp(`
files:
  path/foo:
    src: https://example.com/one
  path/{foo,bar}:
    src: https://example.com/two
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["path/foo"]: duplicate target (expanded from "path/{foo,bar}")',
    );
  });

  it('throws on duplicate: brace key first, explicit key second — shows existing-entry origin', () => {
    const f = writeTmp(`
files:
  path/{foo,bar}:
    src: https://example.com/one
  path/foo:
    src: https://example.com/two
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["path/foo"]: duplicate target (existing entry expanded from "path/{foo,bar}")',
    );
  });

  it('throws on duplicate within the same brace expansion and includes origin key', () => {
    const f = writeTmp(`
files:
  'path/{foo,foo}':
    src: https://example.com/file
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["path/foo"]: duplicate target (expanded from "path/{foo,foo}")',
    );
  });

  it('leaves keys without braces unchanged', () => {
    const f = writeTmp(`
files:
  plain/path.yml:
    src: https://example.com/file
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(Object.keys(config.files)).toEqual(['plain/path.yml']);
  });

  it('leaves single-alternative brace groups (no comma) as literal keys', () => {
    const f = writeTmp(`
files:
  'path/{id}':
    src: https://example.com/file
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(Object.keys(config.files)).toEqual(['path/{id}']);
  });

  it('throws when brace expansion exceeds 100 entries', () => {
    const alts = Array.from({ length: 101 }, (_, i) => `e${i}`).join(',');
    const f = writeTmp(`
files:
  'path/{${alts}}':
    src: https://example.com/file
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'brace expansion exceeds 100 entries',
    );
  });
});

describe('release source parsing', () => {
  it('loads a github release src', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      github:
        repo: owner/repo
        release: v1.0.0
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['downloads/'].src as {
      github: { repo: string; release: string };
    };
    expect(src.github.repo).toBe('owner/repo');
    expect(src.github.release).toBe('v1.0.0');
  });

  it('loads a github release src with $latest', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      github:
        repo: owner/repo
        release: $latest
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['downloads/'].src as {
      github: { repo: string; release: string };
    };
    expect(src.github.release).toBe('$latest');
  });

  it('throws when github src has both file and release', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      github:
        repo: owner/repo
        file: path/to/file.txt
        release: v1.0.0
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'github: "file" and "release" are mutually exclusive',
    );
  });

  it('throws when github src has neither file nor release', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      github:
        repo: owner/repo
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'github: one of "file" or "release" is required',
    );
  });

  it('loads a gitlab release src', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      gitlab:
        project: group/project
        release: v2.0.0
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['downloads/'].src as {
      gitlab: { project: string; release: string };
    };
    expect(src.gitlab.project).toBe('group/project');
    expect(src.gitlab.release).toBe('v2.0.0');
  });

  it('throws when gitlab src has both file and release', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      gitlab:
        project: group/project
        file: path/to/file.txt
        release: v2.0.0
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'gitlab: "file" and "release" are mutually exclusive',
    );
  });

  it('throws when gitlab src has neither file nor release', async () => {
    const f = writeTmp(`
files:
  downloads/:
    src:
      gitlab:
        project: group/project
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'gitlab: one of "file" or "release" is required',
    );
  });
});

describe('filter field parsing', () => {
  it('parses filter on a path src', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      path: ./some-dir
      filter:
        - exact.txt
        - file-{a,b}.yml
        - /^some.*\\.jpg/
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out/'].src as { path: string; filter?: string[] };
    expect(src.filter).toEqual([
      'exact.txt',
      'file-{a,b}.yml',
      '/^some.*\\.jpg/',
    ]);
  });

  it('parses filter on a github release src', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      github:
        repo: owner/repo
        release: v1.0
      filter:
        - exact.png
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out/'].src as {
      github: { release: string };
      filter?: string[];
    };
    expect(src.filter).toEqual(['exact.png']);
  });

  it('parses filter on a gitlab file src', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      gitlab:
        project: group/repo
        file: configs/
      filter:
        - /\\.yml$/
`);
    const cfg = await loadConfig(f);
    const src = cfg.files['out/'].src as {
      gitlab: { file: string };
      filter?: string[];
    };
    expect(src.filter).toEqual(['/\\.yml$/']);
  });

  it('throws when filter is not an array', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      path: ./dir
      filter: exact.txt
`);
    await expect(loadConfig(f)).rejects.toThrow('filter: must be an array');
  });

  it('throws when filter is an empty array', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      path: ./dir
      filter: []
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'filter: must not be an empty array',
    );
  });

  it('throws when a filter entry is not a string', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      path: ./dir
      filter:
        - 42
`);
    await expect(loadConfig(f)).rejects.toThrow(
      'filter[0]: must be a non-empty string',
    );
  });

  it('throws when a regex filter entry is invalid', async () => {
    const f = writeTmp(`
files:
  out/:
    src:
      path: ./dir
      filter:
        - /[invalid/
`);
    await expect(loadConfig(f)).rejects.toThrow('filter[0]: invalid regex');
  });
});

describe('sudo field parsing', () => {
  it('parses sudo: true', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: true
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].sudo).toBe(true);
  });

  it('parses sudo: false as undefined', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: false
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].sudo).toBeUndefined();
  });

  it('parses a username string', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: www-data
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].sudo).toBe('www-data');
  });

  it('leaves sudo undefined when not set', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
`);
    const cfg = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(cfg.files['config.yaml'].sudo).toBeUndefined();
  });

  it('throws for an empty string', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: ""
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["config.yaml"].sudo: must be true or a non-empty username string',
    );
  });

  it('throws for a numeric value', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: 42
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["config.yaml"].sudo: must be true or a non-empty username string',
    );
  });

  it('throws when username starts with a dash', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: "-baduser"
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["config.yaml"].sudo: username must not start with \'-\'',
    );
  });

  it('throws when username is whitespace-only', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: "   "
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'files["config.yaml"].sudo: must be true or a non-empty username string',
    );
  });

  it('trims whitespace from username', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    sudo: "  www-data  "
`);
    const config = parseConfigContent(fs.readFileSync(f, 'utf8'));
    expect(config.files['config.yaml'].sudo).toBe('www-data');
  });

  it('throws when strategy: "insert" is combined with sudo', () => {
    const f = writeTmp(`
files:
  config.yaml:
    src: https://example.com/config.yaml
    strategy: insert
    sudo: true
`);
    expect(() => parseConfigContent(fs.readFileSync(f, 'utf8'))).toThrow(
      'strategy "insert" cannot be combined with sudo',
    );
  });
});
