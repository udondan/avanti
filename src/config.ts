import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  AvantiConfig,
  FileEntry,
  FileSrc,
  HttpSrc,
  LocalSrc,
  UrlSrc,
  JsonArrayStrategy,
  JsonConflictStrategy,
  JsonMergeOptions,
  JsonObjectStrategy,
  YamlArrayStrategy,
  YamlConflictStrategy,
  YamlMergeOptions,
  YamlObjectStrategy,
  TomlArrayStrategy,
  TomlConflictStrategy,
  TomlMergeOptions,
  TomlObjectStrategy,
  ReplaceRule,
  Variables,
} from './types';
import { validateVariables } from './variables';
import { fetchHttp } from './sources/http';
import { fetchGitHub } from './sources/github';
import { fetchGitLab } from './sources/gitlab';
import { fetchGit, isGitRemoteUrl, parseGitRemoteSpec } from './sources/git';

export const SELF_KEY = '$self';

const CONFIG_CANDIDATES = [
  '.avanti.yml',
  '.avanti.yaml',
  'avanti.yml',
  'avanti.yaml',
];

export function isRemoteConfigSpec(s: string): boolean {
  return (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    isGitRemoteUrl(s) ||
    s.startsWith('github:') ||
    s.startsWith('gitlab:')
  );
}

export function normalizeConfigKey(spec: string): string {
  if (spec.startsWith('github:') || spec.startsWith('gitlab:')) {
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

// Parses github:owner/repo:path/to/file.yml[@ref]
function parseGitHubSpec(spec: string): {
  repo: string;
  file: string;
  ref: string | undefined;
} {
  const body = spec.slice('github:'.length);
  const colonIdx = body.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(
      `Invalid github config spec "${spec}". Expected: github:owner/repo:path/to/file.yml[@ref]`,
    );
  }
  const repo = body.slice(0, colonIdx);
  const rest = body.slice(colonIdx + 1);
  const atIdx = rest.lastIndexOf('@');
  const file = atIdx === -1 ? rest : rest.slice(0, atIdx);
  const ref = atIdx === -1 ? undefined : rest.slice(atIdx + 1);
  if (!repo || !file) {
    throw new Error(
      `Invalid github config spec "${spec}". Expected: github:owner/repo:path/to/file.yml[@ref]`,
    );
  }
  return { repo, file, ref };
}

// Parses gitlab:group/project:path/to/file.yml[@ref]
function parseGitLabSpec(spec: string): {
  project: string;
  file: string;
  ref: string | undefined;
} {
  const body = spec.slice('gitlab:'.length);
  const colonIdx = body.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(
      `Invalid gitlab config spec "${spec}". Expected: gitlab:group/project:path/to/file.yml[@ref]`,
    );
  }
  const project = body.slice(0, colonIdx);
  const rest = body.slice(colonIdx + 1);
  const atIdx = rest.lastIndexOf('@');
  const file = atIdx === -1 ? rest : rest.slice(0, atIdx);
  const ref = atIdx === -1 ? undefined : rest.slice(atIdx + 1);
  if (!project || !file) {
    throw new Error(
      `Invalid gitlab config spec "${spec}". Expected: gitlab:group/project:path/to/file.yml[@ref]`,
    );
  }
  return { project, file, ref };
}

async function fetchConfigContent(spec: string): Promise<string> {
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return (await fetchHttp(spec)).toString('utf8');
  }

  if (spec.startsWith('github:')) {
    const { repo, file, ref } = parseGitHubSpec(spec);
    const result = await fetchGitHub(repo, file, ref);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return (result.files.values().next().value as Buffer).toString('utf8');
  }

  if (spec.startsWith('gitlab:')) {
    const { project, file, ref } = parseGitLabSpec(spec);
    const result = await fetchGitLab(project, file, ref);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return (result.files.values().next().value as Buffer).toString('utf8');
  }

  if (isGitRemoteUrl(spec)) {
    const { repo, file, ref } = parseGitRemoteSpec(spec);
    const result = fetchGit(repo, file, ref);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return (result.files.values().next().value as Buffer).toString('utf8');
  }

  // Local file
  if (!fs.existsSync(spec)) {
    throw new Error(`Config file not found: ${spec}`);
  }
  return fs.readFileSync(spec, 'utf8');
}

export function parseConfigContent(content: string): AvantiConfig {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a YAML object');
  }

  const obj = raw as Record<string, unknown>;

  if (
    !obj['files'] ||
    typeof obj['files'] !== 'object' ||
    Array.isArray(obj['files'])
  ) {
    throw new Error('Config must have a "files" map');
  }

  const variables = parseVariables(obj['variables']);

  const filesRaw = obj['files'] as Record<string, unknown>;
  const files: Record<string, FileEntry> = Object.create(null) as Record<
    string,
    FileEntry
  >;

  for (const [target, entry] of Object.entries(filesRaw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`files["${target}"]: must be an object`);
    }
    const e = entry as Record<string, unknown>;

    if (e['src'] === undefined || e['src'] === null) {
      throw new Error(`files["${target}"]: "src" is required`);
    }

    const src = Array.isArray(e['src'])
      ? (e['src'] as unknown[]).map((item, j) =>
          parseSingleSrc(item, target, j),
        )
      : parseSingleSrc(e['src'], target, undefined);

    const fileEntry: FileEntry = { src, target };

    if (typeof e['mode'] === 'string') fileEntry.mode = e['mode'];
    if (typeof e['post'] === 'string') fileEntry.post = e['post'];

    if (e['replace'] !== undefined) {
      if (!Array.isArray(e['replace'])) {
        throw new Error(`files["${target}"]: "replace" must be an array`);
      }
      fileEntry.replace = (e['replace'] as unknown[]).map((r, j) =>
        parseReplaceRule(r, target, j),
      );
    }

    if (e['json'] !== undefined) {
      const rawJson = e['json'];
      if (rawJson === true || rawJson === false) {
        fileEntry.json = rawJson;
      } else {
        fileEntry.json = parseJsonMergeOptions(rawJson, target);
      }
    }

    if (e['yaml'] !== undefined) {
      const rawYaml = e['yaml'];
      if (rawYaml === true || rawYaml === false) {
        fileEntry.yaml = rawYaml;
      } else {
        fileEntry.yaml = parseYamlMergeOptions(rawYaml, target);
      }
    }

    if (e['toml'] !== undefined) {
      const rawToml = e['toml'];
      if (rawToml === true || rawToml === false) {
        fileEntry.toml = rawToml;
      } else {
        fileEntry.toml = parseTomlMergeOptions(rawToml, target);
      }
    }

    files[target] = fileEntry;
  }

  return { variables, files };
}

export async function loadConfig(configPath: string): Promise<AvantiConfig> {
  try {
    const content = await fetchConfigContent(configPath);
    return parseConfigContent(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }
}

function parseVariables(raw: unknown): Variables {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '"variables" must be a map of string keys to string values',
    );
  }
  const obj = raw as Record<string, unknown>;
  const vars: Variables = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val !== 'string') {
      throw new Error(`variables.${key}: value must be a string`);
    }
    vars[key] = val;
  }
  validateVariables(vars);
  return vars;
}

function parseSha(value: unknown, loc: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${loc}.sha: must be a string, got ${typeof value}`);
  }
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${loc}.sha: expected 64 hex characters, got "${value}"`);
  }
  return normalized;
}

function parseSingleSrc(
  raw: unknown,
  target: string,
  j: number | undefined,
): FileSrc {
  const loc =
    j !== undefined ? `files["${target}"].src[${j}]` : `files["${target}"].src`;

  // Plain string → http/https URL or local path
  if (typeof raw === 'string') {
    return raw;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${loc}: must be a string or a map with one of: exec, gitlab, github, bitbucket, git, s3, vault, http, raw`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if ('path' in obj) {
    if (typeof obj['path'] !== 'string' || !obj['path']) {
      throw new Error(`${loc}.path: must be a non-empty string`);
    }
    const result: LocalSrc = { path: obj['path'] };
    if (obj['optional'] !== undefined) {
      if (typeof obj['optional'] !== 'boolean') {
        throw new Error(`${loc}.optional: must be a boolean`);
      }
      result.optional = obj['optional'];
    }
    const pathSha = parseSha(obj['sha'], loc);
    if (pathSha !== undefined) result.sha = pathSha;
    return result;
  }

  if ('url' in obj) {
    if (typeof obj['url'] !== 'string' || !obj['url']) {
      throw new Error(`${loc}.url: must be a non-empty string`);
    }
    if (
      !obj['url'].includes('$') &&
      !obj['url'].startsWith('http://') &&
      !obj['url'].startsWith('https://') &&
      !isGitRemoteUrl(obj['url'])
    ) {
      throw new Error(
        `${loc}.url: must start with http://, https://, git+ssh://, git://, or ssh://, got "${obj['url']}"`,
      );
    }
    const result: UrlSrc = { url: obj['url'] };
    if (obj['optional'] !== undefined) {
      if (typeof obj['optional'] !== 'boolean') {
        throw new Error(`${loc}.optional: must be a boolean`);
      }
      result.optional = obj['optional'];
    }
    const urlSha = parseSha(obj['sha'], loc);
    if (urlSha !== undefined) result.sha = urlSha;
    return result;
  }

  if ('http' in obj) {
    if (typeof obj['http'] !== 'string' || !obj['http']) {
      throw new Error(
        `${loc}.http: must be a non-empty string (http/https URL)`,
      );
    }
    if (
      !obj['http'].includes('$') &&
      !obj['http'].startsWith('http://') &&
      !obj['http'].startsWith('https://')
    ) {
      throw new Error(
        `${loc}.http: must start with http:// or https://, got "${obj['http']}"`,
      );
    }
    const result: HttpSrc = { http: obj['http'] };
    const httpSha = parseSha(obj['sha'], loc);
    if (httpSha !== undefined) result.sha = httpSha;
    return result;
  }

  if ('exec' in obj) {
    if (typeof obj['exec'] !== 'string' || !obj['exec']) {
      throw new Error(`${loc}.exec: must be a non-empty string`);
    }
    const result = { exec: obj['exec'] } as { exec: string; sha?: string };
    const execSha = parseSha(obj['sha'], loc);
    if (execSha !== undefined) result.sha = execSha;
    return result;
  }

  if ('gitlab' in obj) {
    const gl = obj['gitlab'];
    if (!gl || typeof gl !== 'object' || Array.isArray(gl)) {
      throw new Error(`${loc}.gitlab: must be an object`);
    }
    const g = gl as Record<string, unknown>;
    if (typeof g['project'] !== 'string' || !g['project']) {
      throw new Error(`${loc}.gitlab.project: required string`);
    }
    if (typeof g['file'] !== 'string' || !g['file']) {
      throw new Error(`${loc}.gitlab.file: required string`);
    }
    if (
      g['host'] !== undefined &&
      (typeof g['host'] !== 'string' || !g['host'].trim())
    ) {
      throw new Error(`${loc}.gitlab.host: must be a non-empty string`);
    }
    return {
      gitlab: {
        project: g['project'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.gitlab`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
      },
    };
  }

  if ('raw' in obj) {
    if (typeof obj['raw'] !== 'string') {
      throw new Error(`${loc}.raw: must be a string`);
    }
    return { raw: obj['raw'] };
  }

  if ('github' in obj) {
    const gh = obj['github'];
    if (!gh || typeof gh !== 'object' || Array.isArray(gh)) {
      throw new Error(`${loc}.github: must be an object`);
    }
    const g = gh as Record<string, unknown>;
    if (typeof g['repo'] !== 'string' || !g['repo']) {
      throw new Error(`${loc}.github.repo: required string`);
    }
    if (typeof g['file'] !== 'string' || !g['file']) {
      throw new Error(`${loc}.github.file: required string`);
    }
    if (
      g['host'] !== undefined &&
      (typeof g['host'] !== 'string' || !g['host'].trim())
    ) {
      throw new Error(`${loc}.github.host: must be a non-empty string`);
    }
    return {
      github: {
        repo: g['repo'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.github`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
      },
    };
  }

  if ('bitbucket' in obj) {
    const bb = obj['bitbucket'];
    if (!bb || typeof bb !== 'object' || Array.isArray(bb)) {
      throw new Error(`${loc}.bitbucket: must be an object`);
    }
    const b = bb as Record<string, unknown>;
    if (typeof b['workspace'] !== 'string' || !b['workspace']) {
      throw new Error(`${loc}.bitbucket.workspace: required string`);
    }
    if (typeof b['repo'] !== 'string' || !b['repo']) {
      throw new Error(`${loc}.bitbucket.repo: required string`);
    }
    if (typeof b['file'] !== 'string' || !b['file']) {
      throw new Error(`${loc}.bitbucket.file: required string`);
    }
    if (
      b['host'] !== undefined &&
      (typeof b['host'] !== 'string' || !b['host'].trim())
    ) {
      throw new Error(`${loc}.bitbucket.host: must be a non-empty string`);
    }
    return {
      bitbucket: {
        workspace: b['workspace'],
        repo: b['repo'],
        file: b['file'],
        ref: typeof b['ref'] === 'string' ? b['ref'] : undefined,
        sha: parseSha(b['sha'], `${loc}.bitbucket`),
        host: typeof b['host'] === 'string' ? b['host'] : undefined,
      },
    };
  }

  if ('git' in obj) {
    const g = obj['git'];
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      throw new Error(`${loc}.git: must be an object`);
    }
    const gt = g as Record<string, unknown>;
    if (typeof gt['repo'] !== 'string' || !gt['repo']) {
      throw new Error(`${loc}.git.repo: required string`);
    }
    if (typeof gt['file'] !== 'string' || !gt['file']) {
      throw new Error(`${loc}.git.file: required string`);
    }
    return {
      git: {
        repo: gt['repo'],
        file: gt['file'],
        ref: typeof gt['ref'] === 'string' ? gt['ref'] : undefined,
        sha: parseSha(gt['sha'], `${loc}.git`),
      },
    };
  }

  if ('s3' in obj) {
    if (typeof obj['s3'] !== 'string' || !obj['s3']) {
      throw new Error(`${loc}.s3: must be a non-empty string (s3:// URI)`);
    }
    const result = { s3: obj['s3'] } as { s3: string; sha?: string };
    const s3Sha = parseSha(obj['sha'], loc);
    if (s3Sha !== undefined) result.sha = s3Sha;
    return result;
  }

  if ('vault' in obj) {
    const v = obj['vault'];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`${loc}.vault: must be an object`);
    }
    const vt = v as Record<string, unknown>;
    if (typeof vt['path'] !== 'string' || !vt['path']) {
      throw new Error(`${loc}.vault.path: required string`);
    }
    return {
      vault: {
        path: vt['path'],
        field: typeof vt['field'] === 'string' ? vt['field'] : undefined,
        sha: parseSha(vt['sha'], `${loc}.vault`),
      },
    };
  }

  throw new Error(
    `${loc}: unknown source type. Must be a string or map with exec/gitlab/github/bitbucket/git/s3/vault/http/url/path/raw`,
  );
}

function parseMergeOptions<
  C extends string,
  A extends string,
  O extends string,
>(
  raw: unknown,
  target: string,
  kind: string,
  conflictValues: C[],
  arrayValues: A[],
  objectValues: O[],
): { conflicts?: C; arrays?: A; objects?: O } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`files["${target}"]: "${kind}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const opts: { conflicts?: C; arrays?: A; objects?: O } = {};

  if (obj['conflicts'] !== undefined) {
    if (!conflictValues.includes(obj['conflicts'] as C)) {
      throw new Error(
        `files["${target}"].${kind}.conflicts: must be one of ${conflictValues.join(', ')}`,
      );
    }
    opts.conflicts = obj['conflicts'] as C;
  }

  if (obj['arrays'] !== undefined) {
    if (!arrayValues.includes(obj['arrays'] as A)) {
      throw new Error(
        `files["${target}"].${kind}.arrays: must be one of ${arrayValues.join(', ')}`,
      );
    }
    opts.arrays = obj['arrays'] as A;
  }

  if (obj['objects'] !== undefined) {
    if (!objectValues.includes(obj['objects'] as O)) {
      throw new Error(
        `files["${target}"].${kind}.objects: must be one of ${objectValues.join(', ')}`,
      );
    }
    opts.objects = obj['objects'] as O;
  }

  return opts;
}

function parseJsonMergeOptions(raw: unknown, target: string): JsonMergeOptions {
  return parseMergeOptions<
    JsonConflictStrategy,
    JsonArrayStrategy,
    JsonObjectStrategy
  >(
    raw,
    target,
    'json',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat'],
    ['replace', 'merge'],
  );
}

function parseYamlMergeOptions(raw: unknown, target: string): YamlMergeOptions {
  return parseMergeOptions<
    YamlConflictStrategy,
    YamlArrayStrategy,
    YamlObjectStrategy
  >(
    raw,
    target,
    'yaml',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat'],
    ['replace', 'merge'],
  );
}

function parseTomlMergeOptions(raw: unknown, target: string): TomlMergeOptions {
  return parseMergeOptions<
    TomlConflictStrategy,
    TomlArrayStrategy,
    TomlObjectStrategy
  >(
    raw,
    target,
    'toml',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat'],
    ['replace', 'merge'],
  );
}

function parseReplaceRule(r: unknown, target: string, j: number): ReplaceRule {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error(`files["${target}"].replace[${j}]: must be an object`);
  }
  const rule = r as Record<string, unknown>;
  if (typeof rule['from'] !== 'string') {
    throw new Error(
      `files["${target}"].replace[${j}]: "from" must be a string`,
    );
  }
  if (typeof rule['to'] !== 'string') {
    throw new Error(`files["${target}"].replace[${j}]: "to" must be a string`);
  }
  return { from: rule['from'], to: rule['to'] };
}
