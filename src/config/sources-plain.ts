/** Parsers for single-value source types: path, url, http, exec, raw, aws_s3. */
import {
  AwsS3Src,
  ExecSrc,
  FileSrc,
  HttpSrc,
  LocalSrc,
  RawSrc,
  UrlSrc,
} from '../types';
import { isGitRemoteUrl, parseGitRemoteSpec } from '../sources/git';
import { assignConditions, parseConditionField } from './conditions';
import { isNonEmptyString, parseFilter, parseSha } from './validate';

type SrcObject = Record<string, unknown>;

function assignOptional(
  result: { optional?: boolean },
  obj: SrcObject,
  loc: string,
): void {
  if (obj['optional'] === undefined) return;
  if (typeof obj['optional'] !== 'boolean') {
    throw new Error(`${loc}.optional: must be a boolean`);
  }
  result.optional = obj['optional'];
}

function assignFilter(
  result: { filter?: string[] },
  obj: SrcObject,
  loc: string,
): void {
  const filter = parseFilter(obj, loc);
  if (filter !== undefined) result.filter = filter;
}

function assignShaAndConditions(
  result: Exclude<FileSrc, string> & { sha?: string },
  obj: SrcObject,
  loc: string,
): void {
  const sha = parseSha(obj['sha'], loc);
  if (sha !== undefined) result.sha = sha;
  assignConditions(result, parseConditionField(obj, loc));
}

export function parsePathSrc(obj: SrcObject, loc: string): LocalSrc {
  if (!isNonEmptyString(obj['path'])) {
    throw new Error(`${loc}.path: must be a non-empty string`);
  }
  const result: LocalSrc = { path: obj['path'] };
  assignOptional(result, obj, loc);
  assignFilter(result, obj, loc);
  assignShaAndConditions(result, obj, loc);
  return result;
}

function isAcceptedUrl(url: string): boolean {
  return (
    url.includes('$') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    isGitRemoteUrl(url)
  );
}

function validateGitRemoteUrl(url: string, loc: string): void {
  if (url.includes('$') || !isGitRemoteUrl(url)) return;
  try {
    parseGitRemoteSpec(url);
  } catch (err) {
    // parseGitRemoteSpec only ever throws Error instances.
    throw new Error(`${loc}.url: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export function parseUrlSrc(obj: SrcObject, loc: string): UrlSrc {
  const url = obj['url'];
  if (!isNonEmptyString(url)) {
    throw new Error(`${loc}.url: must be a non-empty string`);
  }
  if (!isAcceptedUrl(url)) {
    throw new Error(
      `${loc}.url: must start with http://, https://, git+ssh://, git://, or ssh://, got "${url}"`,
    );
  }
  validateGitRemoteUrl(url, loc);
  const result: UrlSrc = { url };
  assignOptional(result, obj, loc);
  assignShaAndConditions(result, obj, loc);
  return result;
}

export function parseHttpSrc(obj: SrcObject, loc: string): HttpSrc {
  const http = obj['http'];
  if (!isNonEmptyString(http)) {
    throw new Error(`${loc}.http: must be a non-empty string (http/https URL)`);
  }
  if (
    !http.includes('$') &&
    !http.startsWith('http://') &&
    !http.startsWith('https://')
  ) {
    throw new Error(
      `${loc}.http: must start with http:// or https://, got "${http}"`,
    );
  }
  const result: HttpSrc = { http };
  assignShaAndConditions(result, obj, loc);
  return result;
}

export function parseExecSrc(obj: SrcObject, loc: string): ExecSrc {
  if (!isNonEmptyString(obj['exec'])) {
    throw new Error(`${loc}.exec: must be a non-empty string`);
  }
  const result: ExecSrc = { exec: obj['exec'] };
  assignShaAndConditions(result, obj, loc);
  return result;
}

export function parseRawSrc(obj: SrcObject, loc: string): RawSrc {
  if (typeof obj['raw'] !== 'string') {
    throw new Error(`${loc}.raw: must be a string`);
  }
  const rawConds = parseConditionField(obj, loc);
  return { raw: obj['raw'], ...rawConds };
}

export function parseAwsS3Src(obj: SrcObject, loc: string): AwsS3Src {
  if (!isNonEmptyString(obj['aws_s3'])) {
    throw new Error(`${loc}.aws_s3: must be a non-empty string (s3:// URI)`);
  }
  const result: AwsS3Src = { aws_s3: obj['aws_s3'] };
  assignFilter(result, obj, loc);
  assignShaAndConditions(result, obj, loc);
  return result;
}
