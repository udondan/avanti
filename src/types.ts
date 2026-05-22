export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Top-level variable values may not be null (null is rejected by config parsing).
// Nested values within lists/objects may still be null via JsonValue.
export type VariableValue = Exclude<JsonValue, null>;

export type Variables = Record<string, VariableValue>;

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

export interface GitLabFileSrc {
  gitlab: {
    project: string;
    file: string;
    /** Branch, tag, commit, `$latest` (newest semver tag), `$recent` (newest tag), or `/pattern/[flags]`. */
    ref?: string;
    sha?: string;
    host?: string;
    via?: Via | Via[];
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface GitLabReleaseSrc {
  gitlab: {
    project: string;
    /** Tag name, `$latest` (newest semver release; falls back to semver tag scan if releases/latest is non-semver), `$recent` (newest by date), or `/pattern/[flags]`. */
    release: string;
    sha?: string;
    host?: string;
    via?: Via | Via[];
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export type GitLabSrc = GitLabFileSrc | GitLabReleaseSrc;

export interface GitHubFileSrc {
  github: {
    repo: string;
    file: string;
    /** Branch, tag, commit, `$latest` (newest semver tag), `$recent` (newest tag), or `/pattern/[flags]`. */
    ref?: string;
    sha?: string;
    host?: string;
    via?: Via | Via[];
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface GitHubReleaseSrc {
  github: {
    repo: string;
    /** Tag name, `$latest` (newest semver release/tag), `$recent` (newest by date), or `/pattern/[flags]`. */
    release: string;
    sha?: string;
    host?: string;
    via?: Via | Via[];
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export type GitHubSrc = GitHubFileSrc | GitHubReleaseSrc;

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
    /** Branch, tag, `$latest` (newest semver tag), `$recent` (newest tag), or `/pattern/[flags]`. */
    ref?: string;
    sha?: string;
    host?: string;
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface GitSrc {
  git: {
    repo: string;
    file: string;
    /** Branch, tag, commit, `$latest` (newest semver tag), `$recent` (newest tag), or `/pattern/[flags]`. */
    ref?: string;
    sha?: string;
  };
  filter?: string[];
  if?: Condition | Condition[];
  ifAny?: Condition[];
}

export interface AwsS3Src {
  aws_s3: string;
  filter?: string[];
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
  filter?: string[];
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
export type JsonArrayStrategy = 'replace' | 'concat' | 'dedupe';
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
export type YamlArrayStrategy = 'replace' | 'concat' | 'dedupe';
export type YamlObjectStrategy = 'replace' | 'merge';

export interface YamlMergeOptions {
  conflicts?: YamlConflictStrategy;
  arrays?: YamlArrayStrategy;
  objects?: YamlObjectStrategy;
}

export type TomlConflictStrategy = 'abort' | 'first_wins' | 'last_wins';
export type TomlArrayStrategy = 'replace' | 'concat' | 'dedupe';
export type TomlObjectStrategy = 'replace' | 'merge';

export interface TomlMergeOptions {
  conflicts?: TomlConflictStrategy;
  arrays?: TomlArrayStrategy;
  objects?: TomlObjectStrategy;
}

export type TemplateEngine =
  | 'handlebars'
  | 'nunjucks'
  | 'jinja2'
  | 'liquidjs'
  | 'ejs'
  | 'mustache'
  | 'eta';

export const VALID_TEMPLATE_ENGINES: TemplateEngine[] = [
  'handlebars',
  'nunjucks',
  'jinja2',
  'liquidjs',
  'ejs',
  'mustache',
  'eta',
];

export interface FileEntry {
  src: FileSrc | FileSrc[];
  target: string;
  if?: Condition | Condition[];
  ifAny?: Condition[];
  mode?: string;
  backup?: string;
  replace?: ReplaceRule[];
  post?: string;
  template?: TemplateEngine | true;
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
  toml?: TomlMergeOptions | boolean;
  strategy?: 'replace' | 'insert';
  writeInPlace?: boolean;
}

export interface VariableEntry {
  src: FileSrc | FileSrc[];
  json?: JsonMergeOptions | boolean;
  yaml?: YamlMergeOptions | boolean;
  toml?: TomlMergeOptions | boolean;
  template?: TemplateEngine | true;
}

export type VariableSpec = Record<string, VariableValue | VariableEntry>;

export interface AvantiConfig {
  variables?: VariableSpec;
  backup_roots?: string[];
  files: Record<string, FileEntry>;
}
