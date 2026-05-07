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

/** src can be a plain string (http/https URL or local path) or a map for gitlab/github/exec */
export type FileSrc = string | GitLabSrc | GitHubSrc | ExecSrc;

export interface FileEntry {
  src: FileSrc | FileSrc[];
  target?: string;
  mode?: string;
  replace?: ReplaceRule[];
  post?: string;
}

export interface FileFerryConfig {
  files: FileEntry[];
}
