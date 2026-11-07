/** Config file discovery, remote config specs and relative source resolution. */
import * as fs from 'fs';
import * as path from 'path';
import { isGitRemoteUrl, parseGitRemoteSpec } from '../sources/git';
import { isNonLocalSrcString } from '../sources/local';

const CONFIG_CANDIDATES = [
  '.avanti.yml',
  '.avanti.yaml',
  'avanti.yml',
  'avanti.yaml',
];

type GitHostScheme = 'github' | 'gitlab';

function isHttpUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

function gitHostScheme(s: string): GitHostScheme | undefined {
  if (s.startsWith('github:')) return 'github';
  if (s.startsWith('gitlab:')) return 'gitlab';
  return undefined;
}

function refSuffix(ref: string | undefined): string {
  return ref !== undefined ? `@${ref}` : '';
}

/** Splits `path[@ref]` at the last `@`. */
function splitRef(rest: string): { base: string; ref: string | undefined } {
  const atIdx = rest.lastIndexOf('@');
  return atIdx === -1
    ? { base: rest, ref: undefined }
    : { base: rest.slice(0, atIdx), ref: rest.slice(atIdx + 1) };
}

export function isRemoteConfigSpec(s: string): boolean {
  return isHttpUrl(s) || isGitRemoteUrl(s) || gitHostScheme(s) !== undefined;
}

const GIT_HOST_USAGE: Record<GitHostScheme, string> = {
  github: 'github:owner/repo:path/to/file.yml[@ref]',
  gitlab: 'gitlab:group/project:path/to/file.yml[@ref]',
};

// Parses <scheme>:<id>:path/to/file.yml[@ref]
function parseGitHostSpec(
  spec: string,
  scheme: GitHostScheme,
): { id: string; file: string; ref: string | undefined } {
  const invalid = () =>
    new Error(
      `Invalid ${scheme} config spec "${spec}". Expected: ${GIT_HOST_USAGE[scheme]}`,
    );
  const body = spec.slice(scheme.length + 1);
  const colonIdx = body.indexOf(':');
  if (colonIdx === -1) throw invalid();
  const id = body.slice(0, colonIdx);
  const { base: file, ref } = splitRef(body.slice(colonIdx + 1));
  if (!id || !file) throw invalid();
  return { id, file, ref };
}

// Parses github:owner/repo:path/to/file.yml[@ref]
export function parseGitHubSpec(spec: string): {
  repo: string;
  file: string;
  ref: string | undefined;
} {
  const { id, file, ref } = parseGitHostSpec(spec, 'github');
  return { repo: id, file, ref };
}

// Parses gitlab:group/project:path/to/file.yml[@ref]
export function parseGitLabSpec(spec: string): {
  project: string;
  file: string;
  ref: string | undefined;
} {
  const { id, file, ref } = parseGitHostSpec(spec, 'gitlab');
  return { project: id, file, ref };
}

function deriveHttpBase(configPath: string): string {
  const url = new URL(configPath);
  const lastSlash = url.pathname.lastIndexOf('/');
  url.pathname = lastSlash >= 0 ? url.pathname.slice(0, lastSlash + 1) : '/';
  return url.toString();
}

function deriveGitHostBase(configPath: string, scheme: GitHostScheme): string {
  const { id, file, ref } = parseGitHostSpec(configPath, scheme);
  const normalizedFile = file.replace(/\\/g, '/');
  const dir = normalizedFile.includes('/')
    ? normalizedFile.slice(0, normalizedFile.lastIndexOf('/'))
    : '';
  return `${scheme}:${id}:${dir}${refSuffix(ref)}`;
}

function deriveGitRemoteBase(configPath: string): string {
  const { repo, file, ref } = parseGitRemoteSpec(configPath);
  const normalizedFile = file.replace(/\\/g, '/');
  const dir = path.posix.dirname(normalizedFile);
  const dirPart = dir === '.' ? '' : dir;
  return `${repo}//${dirPart}${refSuffix(ref)}`;
}

export function deriveConfigBase(configPath: string): string {
  if (isHttpUrl(configPath)) return deriveHttpBase(configPath);
  const scheme = gitHostScheme(configPath);
  if (scheme) return deriveGitHostBase(configPath, scheme);
  if (isGitRemoteUrl(configPath)) return deriveGitRemoteBase(configPath);
  return path.dirname(configPath);
}

const PASSTHROUGH_PREFIXES = ['/', '~/'];

function isPassthroughSrc(src: string): boolean {
  return (
    PASSTHROUGH_PREFIXES.some((p) => src.startsWith(p)) ||
    path.isAbsolute(src) ||
    isNonLocalSrcString(src)
  );
}

function resolveRelativeHttp(src: string, configBase: string): string {
  const normalizedSrc = src.replace(/\\/g, '/');
  const resolvedUrl = new URL(normalizedSrc, configBase);
  const baseUrl = new URL(configBase);
  if (baseUrl.search) {
    const baseParams = new URLSearchParams(baseUrl.search);
    const resolvedParams = new URLSearchParams(resolvedUrl.search);
    const overriddenKeys = new Set(resolvedParams.keys());
    for (const [key, val] of baseParams.entries()) {
      if (!overriddenKeys.has(key)) resolvedParams.append(key, val);
    }
    resolvedUrl.search = resolvedParams.toString();
  }
  return resolvedUrl.href;
}

function resolveGitRelativePath(
  rest: string,
  src: string,
  configBase: string,
): { file: string; refSuffix: string } {
  const { base: dir, ref } = splitRef(rest);
  const normalizedSrc = src.replace(/\\/g, '/');
  const file = path.posix.join(dir, normalizedSrc);
  if (file.startsWith('../') || file === '..') {
    throw new Error(
      `Relative source path '${src}' escapes the repository root for config base '${configBase}'`,
    );
  }
  return { file, refSuffix: refSuffix(ref) };
}

function resolveRelativeGitHostSpec(
  src: string,
  configBase: string,
  scheme: GitHostScheme,
): string {
  const prefix = `${scheme}:`;
  const body = configBase.slice(prefix.length);
  const colonIdx = body.indexOf(':');
  const id = colonIdx >= 0 ? body.slice(0, colonIdx) : body;
  const rest = colonIdx >= 0 ? body.slice(colonIdx + 1) : '';
  const { file, refSuffix } = resolveGitRelativePath(rest, src, configBase);
  return `${prefix}${id}:${file}${refSuffix}`;
}

function resolveRelativeGitRemoteSpec(src: string, configBase: string): string {
  const schemeEnd = configBase.indexOf('://') + 3;
  const separatorIdx = configBase.indexOf('//', schemeEnd);
  const repo =
    separatorIdx >= 0 ? configBase.slice(0, separatorIdx) : configBase;
  const rest = separatorIdx >= 0 ? configBase.slice(separatorIdx + 2) : '';
  const { file, refSuffix } = resolveGitRelativePath(rest, src, configBase);
  return `${repo}//${file}${refSuffix}`;
}

export function resolveRelativeSrc(src: string, configBase: string): string {
  if (isPassthroughSrc(src)) return src;
  if (isHttpUrl(configBase)) return resolveRelativeHttp(src, configBase);
  const scheme = gitHostScheme(configBase);
  if (scheme) return resolveRelativeGitHostSpec(src, configBase, scheme);
  if (isGitRemoteUrl(configBase)) {
    return resolveRelativeGitRemoteSpec(src, configBase);
  }
  return path.resolve(configBase, src);
}

export function normalizeConfigKey(spec: string): string {
  if (gitHostScheme(spec)) {
    const atIdx = spec.lastIndexOf('@');
    if (atIdx !== -1) return spec.slice(0, atIdx);
  }
  if (isGitRemoteUrl(spec)) {
    try {
      const { repo, file, ref } = parseGitRemoteSpec(spec);
      if (ref !== undefined) return `${repo}//${file}`;
    } catch {
      // invalid spec — fall through and return as-is
    }
  }
  return spec;
}

export function resolveConfigPath(explicit?: string): string {
  if (explicit) {
    if (isRemoteConfigSpec(explicit)) return explicit;
    return path.resolve(explicit);
  }

  const cwd = process.cwd();
  const entries = fs.readdirSync(cwd);
  const lowerEntries = entries.map((e) => e.toLowerCase());

  for (const candidate of CONFIG_CANDIDATES) {
    const idx = lowerEntries.indexOf(candidate);
    if (idx !== -1) return path.resolve(cwd, entries[idx]);
  }

  return path.resolve(cwd, CONFIG_CANDIDATES[0]);
}
