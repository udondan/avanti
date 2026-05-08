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

/** src can be a plain string (http/https URL or local path) or a map for gitlab/github/exec/raw */
export type FileSrc = string | GitLabSrc | GitHubSrc | ExecSrc | RawSrc;

export type JsonConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type JsonArrayStrategy = 'replace' | 'concat';
export type JsonObjectStrategy = 'replace' | 'merge';

export interface JsonMergeOptions {
  conflicts?: JsonConflictStrategy;
  arrays?: JsonArrayStrategy;
  objects?: JsonObjectStrategy;
}

export interface FileEntry {
  src: FileSrc | FileSrc[];
  target?: string;
  mode?: string;
  replace?: ReplaceRule[];
  post?: string;
  json?: JsonMergeOptions | boolean;
}

export interface FileFerryConfig {
  variables?: Variables;
  files: FileEntry[];
}
