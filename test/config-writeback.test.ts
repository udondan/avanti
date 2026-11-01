import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { applyUpdatedShas } from '../src/config-writeback';

const SHA = 'f'.repeat(64);

/** Wraps a single src item (YAML lines, indented for a list item) in a config. */
function configWith(srcItem: string): string {
  return `files:\n  out.txt:\n    src:\n${srcItem}`;
}

/** Applies `label → SHA` and returns the parsed src[0] of the result. */
function applyOne(srcItem: string, label: string): Record<string, unknown> {
  const out = applyUpdatedShas(configWith(srcItem), new Map([[label, SHA]]));
  expect(out).not.toBeNull();
  const parsed = parse(out!) as {
    files: { 'out.txt': { src: Record<string, unknown>[] } };
  };
  return parsed.files['out.txt'].src[0];
}

describe('applyUpdatedShas — label derivation per source type', () => {
  it('github release with host', () => {
    const src = applyOne(
      `      - github:\n          repo: org/repo\n          release: v1\n          host: ghe.example.com\n`,
      'github[ghe.example.com]:org/repo:release:v1',
    );
    expect((src.github as Record<string, unknown>).sha).toBe(SHA);
  });

  it('gitlab file with ref and host', () => {
    const src = applyOne(
      `      - gitlab:\n          project: grp/proj\n          file: a.txt\n          ref: main\n          host: gl.example.com\n`,
      'gitlab[gl.example.com]:grp/proj:a.txt@main',
    );
    expect((src.gitlab as Record<string, unknown>).sha).toBe(SHA);
  });

  it('gitlab file without ref or host', () => {
    const src = applyOne(
      `      - gitlab:\n          project: grp/proj\n          file: a.txt\n`,
      'gitlab:grp/proj:a.txt',
    );
    expect((src.gitlab as Record<string, unknown>).sha).toBe(SHA);
  });

  it('gitlab release', () => {
    const src = applyOne(
      `      - gitlab:\n          project: grp/proj\n          release: v2\n`,
      'gitlab:grp/proj:release:v2',
    );
    expect((src.gitlab as Record<string, unknown>).sha).toBe(SHA);
  });

  it('gitlab without file or release is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - gitlab:\n          project: grp/proj\n`),
        new Map([['gitlab:grp/proj:', SHA]]),
      ),
    ).toBeNull();
  });

  it('bitbucket with ref and host', () => {
    const src = applyOne(
      `      - bitbucket:\n          workspace: ws\n          repo: r\n          file: f.txt\n          ref: dev\n          host: bb.example.com\n`,
      'bitbucket[bb.example.com]:ws/r:f.txt@dev',
    );
    expect((src.bitbucket as Record<string, unknown>).sha).toBe(SHA);
  });

  it('bitbucket without ref or host', () => {
    const src = applyOne(
      `      - bitbucket:\n          workspace: ws\n          repo: r\n          file: f.txt\n`,
      'bitbucket:ws/r:f.txt',
    );
    expect((src.bitbucket as Record<string, unknown>).sha).toBe(SHA);
  });

  it('bitbucket missing file is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(
          `      - bitbucket:\n          workspace: ws\n          repo: r\n`,
        ),
        new Map([['bitbucket:ws/r:', SHA]]),
      ),
    ).toBeNull();
  });

  it('git with and without ref', () => {
    const withRef = applyOne(
      `      - git:\n          repo: https://example.com/r.git\n          file: f.txt\n          ref: v1\n`,
      'git:https://example.com/r.git:f.txt@v1',
    );
    expect((withRef.git as Record<string, unknown>).sha).toBe(SHA);
    const noRef = applyOne(
      `      - git:\n          repo: https://example.com/r.git\n          file: f.txt\n`,
      'git:https://example.com/r.git:f.txt',
    );
    expect((noRef.git as Record<string, unknown>).sha).toBe(SHA);
  });

  it('git without file is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - git:\n          repo: https://example.com/r.git\n`),
        new Map([['git:https://example.com/r.git:', SHA]]),
      ),
    ).toBeNull();
  });

  it('exec writes sha beside the exec key', () => {
    const src = applyOne(`      - exec: echo hi\n`, 'exec:echo hi');
    expect(src.sha).toBe(SHA);
  });

  it('empty exec is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - exec: ""\n`),
        new Map([['exec:', SHA]]),
      ),
    ).toBeNull();
  });

  it('aws_s3 with filter', () => {
    const src = applyOne(
      `      - aws_s3: s3://bucket/prefix/\n        filter:\n          - "*.txt"\n          - ""\n`,
      `aws_s3:s3://bucket/prefix/\x00filter:${JSON.stringify(['*.txt'])}`,
    );
    expect(src.sha).toBe(SHA);
  });

  it('aws_s3 with a filter of only empty entries uses the bare label', () => {
    const src = applyOne(
      `      - aws_s3: s3://bucket/key\n        filter:\n          - ""\n`,
      'aws_s3:s3://bucket/key',
    );
    expect(src.sha).toBe(SHA);
  });

  it('empty aws_s3 is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - aws_s3: ""\n`),
        new Map([['aws_s3:', SHA]]),
      ),
    ).toBeNull();
  });

  it('aws_secrets_manager with key and region', () => {
    const src = applyOne(
      `      - aws_secrets_manager:\n          name: my/secret\n          key: password\n          region: eu-west-1\n`,
      'aws_secrets_manager:my/secret#password@eu-west-1',
    );
    expect((src.aws_secrets_manager as Record<string, unknown>).sha).toBe(SHA);
  });

  it('aws_secrets_manager without key or region', () => {
    const src = applyOne(
      `      - aws_secrets_manager:\n          name: my/secret\n`,
      'aws_secrets_manager:my/secret',
    );
    expect((src.aws_secrets_manager as Record<string, unknown>).sha).toBe(SHA);
  });

  it('aws_secrets_manager without name is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - aws_secrets_manager:\n          key: k\n`),
        new Map([['aws_secrets_manager:', SHA]]),
      ),
    ).toBeNull();
  });

  it('aws_systems_manager_parameter with and without region', () => {
    const withRegion = applyOne(
      `      - aws_systems_manager_parameter:\n          name: /app/p\n          region: us-east-1\n`,
      'aws_systems_manager_parameter:/app/p@us-east-1',
    );
    expect(
      (withRegion.aws_systems_manager_parameter as Record<string, unknown>).sha,
    ).toBe(SHA);
    const noRegion = applyOne(
      `      - aws_systems_manager_parameter:\n          name: /app/p\n`,
      'aws_systems_manager_parameter:/app/p',
    );
    expect(
      (noRegion.aws_systems_manager_parameter as Record<string, unknown>).sha,
    ).toBe(SHA);
  });

  it('aws_systems_manager_parameter without name is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(
          `      - aws_systems_manager_parameter:\n          region: us-east-1\n`,
        ),
        new Map([['aws_systems_manager_parameter:', SHA]]),
      ),
    ).toBeNull();
  });

  it('vault with and without field', () => {
    const withField = applyOne(
      `      - vault:\n          path: secret/data/app\n          field: token\n`,
      'vault:secret/data/app#token',
    );
    expect((withField.vault as Record<string, unknown>).sha).toBe(SHA);
    const noField = applyOne(
      `      - vault:\n          path: secret/data/app\n`,
      'vault:secret/data/app',
    );
    expect((noField.vault as Record<string, unknown>).sha).toBe(SHA);
  });

  it('vault without path is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - vault:\n          field: token\n`),
        new Map([['vault:', SHA]]),
      ),
    ).toBeNull();
  });

  it('http writes sha beside the http key', () => {
    const src = applyOne(
      `      - http: https://example.com/a\n`,
      'http:https://example.com/a',
    );
    expect(src.sha).toBe(SHA);
  });

  it('empty http is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - http: ""\n`),
        new Map([['http:', SHA]]),
      ),
    ).toBeNull();
  });

  it('path with filter', () => {
    const src = applyOne(
      `      - path: ./dir\n        filter:\n          - "*.md"\n`,
      `path:./dir\x00filter:${JSON.stringify(['*.md'])}`,
    );
    expect(src.sha).toBe(SHA);
  });

  it('empty path is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - path: ""\n`),
        new Map([['path:', SHA]]),
      ),
    ).toBeNull();
  });

  it('url writes sha beside the url key', () => {
    const src = applyOne(
      `      - url: https://example.com/u\n`,
      'url:https://example.com/u',
    );
    expect(src.sha).toBe(SHA);
  });

  it('empty url is ignored', () => {
    expect(
      applyUpdatedShas(
        configWith(`      - url: ""\n`),
        new Map([['url:', SHA]]),
      ),
    ).toBeNull();
  });

  it('single-map src (not a list) writes sha without an index', () => {
    const raw = `files:\n  out.txt:\n    src:\n      http: https://example.com/a\n`;
    const out = applyUpdatedShas(
      raw,
      new Map([['http:https://example.com/a', SHA]]),
    );
    const parsed = parse(out!) as {
      files: { 'out.txt': { src: Record<string, unknown> } };
    };
    expect(parsed.files['out.txt'].src.sha).toBe(SHA);
  });

  it('returns null when the sha is already up to date', () => {
    expect(
      applyUpdatedShas(
        configWith(
          `      - http: https://example.com/a\n        sha: ${SHA}\n`,
        ),
        new Map([['http:https://example.com/a', SHA]]),
      ),
    ).toBeNull();
  });

  it('returns null when there is no files map', () => {
    expect(
      applyUpdatedShas('variables: {}\n', new Map([['http:x', SHA]])),
    ).toBeNull();
  });

  it('skips scalar src items and entries without src', () => {
    const raw = `files:\n  a.txt:\n    src:\n      - https://example.com/a\n  b.txt:\n    content: hi\n  c.txt: plain\n`;
    expect(
      applyUpdatedShas(raw, new Map([['http:https://example.com/a', SHA]])),
    ).toBeNull();
  });
});
