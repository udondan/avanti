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
  };
}

export interface GitHubSrc {
  github: {
    repo: string;
    file: string;
    ref?: string;
  };
}

export interface ExecSrc {
  exec: string;
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
  };
}

export interface GitSrc {
  git: {
    repo: string;
    file: string;
    ref?: string;
  };
}

export interface S3Src {
  s3: string;
}

export interface VaultSrc {
  vault: {
    path: string;
    field?: string;
  };
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
  | VaultSrc;

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
  target?: string;
  mode?: string;
  replace?: ReplaceRule[];
  post?: string;
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
}

export interface FileFerryConfig {
  variables?: Variables;
  files: FileEntry[];
}
