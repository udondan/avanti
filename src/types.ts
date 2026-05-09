export type Variables = Record<string, string>;

export interface ReplaceRule {
  from: string;
  to: string;
}

export interface GitLabSrc {
  gitlab: {
    project: string;
    file: string;
    ref?: string;
    sha?: string;
  };
}

export interface GitHubSrc {
  github: {
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
  };
}

export interface ExecSrc {
  exec: string;
  sha?: string;
}

export interface RawSrc {
  raw: string;
}

export interface BitbucketSrc {
  bitbucket: {
    workspace: string;
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
  };
}

export interface GitSrc {
  git: {
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
  };
}

export interface S3Src {
  s3: string;
  sha?: string;
}

export interface VaultSrc {
  vault: {
    path: string;
    field?: string;
    sha?: string;
  };
}

/** An explicit http/https URL with optional SHA pinning */
export interface HttpSrc {
  http: string;
  sha?: string;
}

/** An explicit local filesystem path; optional: true silently skips if the path does not exist */
export interface LocalSrc {
  path: string;
  optional?: boolean;
  sha?: string;
}

/** An explicit http/https URL; optional: true silently skips on 404 */
export interface UrlSrc {
  url: string;
  optional?: boolean;
  sha?: string;
}

/** src can be a plain string (http/https URL or local path) or a typed source map */
export type FileSrc =
  | string
  | GitLabSrc
  | GitHubSrc
  | BitbucketSrc
  | GitSrc
  | ExecSrc
  | RawSrc
  | S3Src
  | VaultSrc
  | HttpSrc
  | LocalSrc
  | UrlSrc;

export type JsonConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type JsonArrayStrategy = 'replace' | 'concat';
export type JsonObjectStrategy = 'replace' | 'merge';

export interface JsonMergeOptions {
  conflicts?: JsonConflictStrategy;
  arrays?: JsonArrayStrategy;
  objects?: JsonObjectStrategy;
}

export type YamlConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type YamlArrayStrategy = 'replace' | 'concat';
export type YamlObjectStrategy = 'replace' | 'merge';

export interface YamlMergeOptions {
  conflicts?: YamlConflictStrategy;
  arrays?: YamlArrayStrategy;
  objects?: YamlObjectStrategy;
}

export interface FileEntry {
  src: FileSrc | FileSrc[];
  target: string;
  mode?: string;
  replace?: ReplaceRule[];
  post?: string;
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
}

export interface AvantiConfig {
  variables?: Variables;
  files: Record<string, FileEntry>;
}
