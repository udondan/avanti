/** Source labels used to match config `src` items against updated SHAs. */

export type NodeGet = (k: string, keepScalar?: boolean) => unknown;

export type NodeLike = { get?: NodeGet } | null;

export interface ItemNode {
  get: NodeGet;
}

type Getter = (k: string) => string | null;

/** Returns `prefix + value` when value is truthy, otherwise ''. */
function opt(prefix: string, value: string | null): string {
  return value ? prefix + value : '';
}

function hostPart(host: string | null): string {
  return host ? '[' + host + ']' : '';
}

function forgeLabel(kind: 'github' | 'gitlab', idKey: 'repo' | 'project') {
  return (get: Getter): string | null => {
    const id = get(idKey);
    const file = get('file');
    const release = get('release');
    const ref = get('ref');
    const host = get('host');
    if (!id || !(file || release)) return null;
    const prefix = `${kind}${hostPart(host)}:${id}:`;
    return release
      ? `${prefix}release:${release}`
      : `${prefix}${file}${opt('@', ref)}`;
  };
}

function bitbucketLabel(get: Getter): string | null {
  const ws = get('workspace');
  const repo = get('repo');
  const file = get('file');
  if (!ws || !repo || !file) return null;
  const host = hostPart(get('host'));
  return `bitbucket${host}:${ws}/${repo}:${file}${opt('@', get('ref'))}`;
}

function gitLabel(get: Getter): string | null {
  const repo = get('repo');
  const file = get('file');
  const ref = get('ref');
  if (!repo || !file) return null;
  return `git:${repo}:${file}${opt('@', ref)}`;
}

function secretsManagerLabel(get: Getter): string | null {
  const name = get('name');
  const key = get('key');
  const region = get('region');
  if (!name) return null;
  return `aws_secrets_manager:${name}${opt('#', key)}${opt('@', region)}`;
}

function ssmLabel(get: Getter): string | null {
  const name = get('name');
  const region = get('region');
  if (!name) return null;
  return `aws_systems_manager_parameter:${name}${opt('@', region)}`;
}

function vaultLabel(get: Getter): string | null {
  const path = get('path');
  const field = get('field');
  if (!path) return null;
  return `vault:${path}${opt('#', field)}`;
}

interface SrcKind {
  key: string;
  /** Nested map sources (e.g. github:) vs. scalar sources (e.g. exec:). */
  nested?: (get: Getter) => string | null;
  supportsFilter: boolean;
}

// Checked in this order; the first key present on the item selects the kind.
export const SRC_KINDS: SrcKind[] = [
  { key: 'github', nested: forgeLabel('github', 'repo'), supportsFilter: true },
  {
    key: 'gitlab',
    nested: forgeLabel('gitlab', 'project'),
    supportsFilter: true,
  },
  { key: 'bitbucket', nested: bitbucketLabel, supportsFilter: true },
  { key: 'git', nested: gitLabel, supportsFilter: true },
  { key: 'exec', supportsFilter: false },
  { key: 'aws_s3', supportsFilter: true },
  {
    key: 'aws_secrets_manager',
    nested: secretsManagerLabel,
    supportsFilter: false,
  },
  {
    key: 'aws_systems_manager_parameter',
    nested: ssmLabel,
    supportsFilter: false,
  },
  { key: 'vault', nested: vaultLabel, supportsFilter: false },
  { key: 'http', supportsFilter: false },
  { key: 'path', supportsFilter: true },
  { key: 'url', supportsFilter: false },
];

/** Nested kinds match on a truthy value, scalar kinds on any defined value. */
export function isPresent(kind: SrcKind, value: unknown): boolean {
  return kind.nested ? !!value : value !== undefined;
}

export function kindLabel(kind: SrcKind, value: unknown): string | null {
  if (!kind.nested) {
    const scalar = value as string | null;
    return scalar ? `${kind.key}:${scalar}` : null;
  }
  const node = value as NodeLike;
  if (!node?.get) return null;
  const nodeGet = node.get.bind(node);
  return kind.nested((k) => nodeGet(k) as string | null);
}
