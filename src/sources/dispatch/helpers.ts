import { Variables } from '../../types';
import { resolveVars } from '../../variables';
import { inferFilenameFromUrl } from '../http';
import { parseGitRemoteSpec } from '../git';

/** `prefix + value` when value is truthy, otherwise `''`. */
export function prefixIfSet(prefix: string, value: string | undefined): string {
  return value ? `${prefix}${value}` : '';
}

/** `prefix + resolved value` when value is truthy, otherwise `''`. */
export function prefixResolvedIfSet(
  prefix: string,
  value: string | undefined,
  vars: Variables,
): string {
  return value ? `${prefix}${resolveVars(value, vars)}` : '';
}

/** `prefix + value` when value is defined, otherwise `''`. */
export function prefixIfDefined(
  prefix: string,
  value: string | undefined,
): string {
  return value !== undefined ? `${prefix}${value}` : '';
}

/** `prefix + resolved value` when value is defined, otherwise `''`. */
export function prefixResolvedIfDefined(
  prefix: string,
  value: string | undefined,
  vars: Variables,
): string {
  return value !== undefined ? `${prefix}${resolveVars(value, vars)}` : '';
}

/** `[host]` tag for labels; empty when no host is set. */
export function hostTag(host: string | undefined): string {
  return host ? `[${host}]` : '';
}

/** `[host]` tag for cache keys, resolved and trimmed; empty when blank. */
export function resolvedHostTag(
  host: string | undefined,
  vars: Variables,
): string {
  const resolvedHost = host ? resolveVars(host, vars).trim() : '';
  return resolvedHost ? `[${resolvedHost}]` : '';
}

/** Resolves variables in an optional value, keeping `undefined`. */
export function resolveOptional(
  value: string | undefined,
  vars: Variables,
): string | undefined {
  return value !== undefined ? resolveVars(value, vars) : undefined;
}

/** Resolves variables in an optional value; empty results become `undefined`. */
export function resolveNonEmpty(
  value: string | undefined,
  vars: Variables,
): string | undefined {
  return value !== undefined
    ? resolveVars(value, vars) || undefined
    : undefined;
}

export function shaOf(src: { sha?: string }): string | undefined {
  return src.sha;
}

export function filterOf(src: { filter?: string[] }): string[] | undefined {
  return src.filter;
}

export function isHttpUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

/** URL pathname, or the input itself when it is not a parseable URL. */
export function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url; // variable-driven URL; pathname unavailable at parse time
  }
}

/** File part of a git remote spec, or the input itself when unparseable. */
export function gitRemoteFile(spec: string): string {
  try {
    return parseGitRemoteSpec(spec).file;
  } catch {
    return spec;
  }
}

/** Single-file map for downloaded content, named after the URL. */
export function downloadFiles(
  url: string,
  content: Buffer,
): Map<string, Buffer> {
  const filename = inferFilenameFromUrl(url) ?? 'download';
  return new Map([[filename, content]]);
}
