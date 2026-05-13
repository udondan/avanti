export type Variables = Record<string, string>;

export type Via = 'api' | 'cli';

export type OsPlatform = 'linux' | 'mac' | 'windows';

export interface Condition {
  os?: OsPlatform | OsPlatform[];
  exists?: string;
  exec?: string;
  target_exists?: boolean;
  not?: boolean;
}

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
    host?: string;
    via?: Via | Via[];
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface GitHubSrc {
  github: {
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
    host?: string;
    via?: Via | Via[];
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface ExecSrc {
  exec: string;
  sha?: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface RawSrc {
  raw: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface BitbucketSrc {
  bitbucket: {
    workspace: string;
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
    host?: string;
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface GitSrc {
  git: {
    repo: string;
    file: string;
    ref?: string;
    sha?: string;
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface AwsS3Src {
  aws_s3: string;
  sha?: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface AwsSecretsManagerSrc {
  aws_secrets_manager: {
    name: string;
    key?: string;
    region?: string;
    sha?: string;
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface AwsSsmSrc {
  aws_systems_manager_parameter: {
    name: string;
    region?: string;
    sha?: string;
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface VaultSrc {
  vault: {
    path: string;
    field?: string;
    sha?: string;
  };
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

/** An explicit http/https URL with optional SHA pinning */
export interface HttpSrc {
  http: string;
  sha?: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

/** An explicit local filesystem path; optional: true silently skips if the path does not exist */
export interface LocalSrc {
  path: string;
  optional?: boolean;
  sha?: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

/** An explicit http/https URL; optional: true silently skips on 404 */
export interface UrlSrc {
  url: string;
  optional?: boolean;
  sha?: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
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
  | AwsS3Src
  | AwsSecretsManagerSrc
  | AwsSsmSrc
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
  indent?: number | 'tab';
  trailingCommas?: boolean;
  sortKeys?: boolean;
  minify?: boolean;
  stripComments?: boolean;
}

export type YamlConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type YamlArrayStrategy = 'replace' | 'concat';
export type YamlObjectStrategy = 'replace' | 'merge';

export interface YamlMergeOptions {
  conflicts?: YamlConflictStrategy;
  arrays?: YamlArrayStrategy;
  objects?: YamlObjectStrategy;
}

export type TomlConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type TomlArrayStrategy = 'replace' | 'concat';
export type TomlObjectStrategy = 'replace' | 'merge';

export interface TomlMergeOptions {
  conflicts?: TomlConflictStrategy;
  arrays?: TomlArrayStrategy;
  objects?: TomlObjectStrategy;
}

export interface FileEntry {
  src: FileSrc | FileSrc[];
  target: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
  mode?: string;
  replace?: ReplaceRule[];
  post?: string;
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
  toml?: TomlMergeOptions | boolean;
}

export interface VariableEntry {
  src: FileSrc | FileSrc[];
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
  toml?: TomlMergeOptions | boolean;
}

export type VariableSpec = Record<string, string | VariableEntry>;

export interface AvantiConfig {
  variables?: VariableSpec;
  files: Record<string, FileEntry>;
}
