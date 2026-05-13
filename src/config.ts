import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  AvantiConfig,
  AwsS3Src,
  Condition,
  ExecSrc,
  FileEntry,
  FileSrc,
  HttpSrc,
  LocalSrc,
  OsPlatform,
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
  VariableEntry,
  VariableSpec,
  Via,
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

async function fetchConfigContent(
  spec: string,
  via?: Via | Via[],
): Promise<string> {
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return (await fetchHttp(spec)).toString('utf8');
  }

  if (spec.startsWith('github:')) {
    const { repo, file, ref } = parseGitHubSpec(spec);
    const result = await fetchGitHub(repo, file, ref, undefined, via);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return (result.files.values().next().value as Buffer).toString('utf8');
  }

  if (spec.startsWith('gitlab:')) {
    const { project, file, ref } = parseGitLabSpec(spec);
    const result = await fetchGitLab(project, file, ref, undefined, via);
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
          parseSingleSrc(item, `files["${target}"].src[${j}]`),
        )
      : parseSingleSrc(e['src'], `files["${target}"].src`);

    const fileEntry: FileEntry = { src, target };

    const fileConds = parseConditionField(e, `files["${target}"]`);
    if (fileConds['if'] !== undefined) fileEntry['if'] = fileConds['if'];
    if (fileConds.ifAny !== undefined) fileEntry.ifAny = fileConds.ifAny;

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
        fileEntry.json = parseJsonMergeOptions(rawJson, `files["${target}"]`);
      }
    }

    if (e['yaml'] !== undefined) {
      const rawYaml = e['yaml'];
      if (rawYaml === true || rawYaml === false) {
        fileEntry.yaml = rawYaml;
      } else {
        fileEntry.yaml = parseYamlMergeOptions(rawYaml, `files["${target}"]`);
      }
    }

    if (e['toml'] !== undefined) {
      const rawToml = e['toml'];
      if (rawToml === true || rawToml === false) {
        fileEntry.toml = rawToml;
      } else {
        fileEntry.toml = parseTomlMergeOptions(rawToml, `files["${target}"]`);
      }
    }

    files[target] = fileEntry;
  }

  return { variables, files };
}

export async function loadConfig(
  configPath: string,
  via?: Via | Via[],
): Promise<AvantiConfig> {
  try {
    const content = await fetchConfigContent(configPath, via);
    return parseConfigContent(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }
}

function parseVariables(raw: unknown): VariableSpec {
  if (raw === undefined || raw === null)
    return Object.create(null) as VariableSpec;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '"variables" must be a map of variable names to string values or source objects',
    );
  }
  const obj = raw as Record<string, unknown>;
  const spec: VariableSpec = Object.create(null) as VariableSpec;
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      spec[key] = val;
    } else if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      'src' in val
    ) {
      spec[key] = parseVariableEntry(val, key);
    } else {
      throw new Error(
        `variables.${key}: value must be a string or a source object with "src"`,
      );
    }
  }
  validateVariables(spec);
  return spec;
}

function parseVariableEntry(
  obj: Record<string, unknown>,
  varName: string,
): VariableEntry {
  const loc = `variables.${varName}`;
  const rawSrc = obj['src'];
  if (rawSrc === undefined || rawSrc === null) {
    throw new Error(`${loc}: "src" is required`);
  }
  const src = Array.isArray(rawSrc)
    ? (rawSrc as unknown[]).map((item, j) =>
        parseSingleSrc(item, `${loc}.src[${j}]`),
      )
    : parseSingleSrc(rawSrc, `${loc}.src`);
  const entry: VariableEntry = { src };

  if (obj['json'] !== undefined) {
    const rawJson = obj['json'];
    if (rawJson === true || rawJson === false) {
      entry.json = rawJson;
    } else {
      entry.json = parseJsonMergeOptions(rawJson, loc);
    }
  }

  if (obj['yaml'] !== undefined) {
    const rawYaml = obj['yaml'];
    if (rawYaml === true || rawYaml === false) {
      entry.yaml = rawYaml;
    } else {
      entry.yaml = parseYamlMergeOptions(rawYaml, loc);
    }
  }

  if (obj['toml'] !== undefined) {
    const rawToml = obj['toml'];
    if (rawToml === true || rawToml === false) {
      entry.toml = rawToml;
    } else {
      entry.toml = parseTomlMergeOptions(rawToml, loc);
    }
  }

  return entry;
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

export function parseVia(value: unknown, loc: string): Via | Via[] | undefined {
  if (value === undefined || value === null) return undefined;
  const valid: Via[] = ['api', 'cli'];
  if (typeof value === 'string') {
    if (!valid.includes(value as Via)) {
      throw new Error(`${loc}.via: must be "api" or "cli", got "${value}"`);
    }
    return value as Via;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`${loc}.via: array must not be empty`);
    }
    if (value.length > valid.length) {
      throw new Error(
        `${loc}.via: array must not have more than ${valid.length} entries`,
      );
    }
    const seen = new Set<Via>();
    const result = value.map((v, i) => {
      if (!valid.includes(v as Via)) {
        throw new Error(`${loc}.via[${i}]: must be "api" or "cli", got "${v}"`);
      }
      if (seen.has(v as Via)) {
        throw new Error(`${loc}.via[${i}]: duplicate value "${v}"`);
      }
      seen.add(v as Via);
      return v as Via;
    });
    return result;
  }
  throw new Error(`${loc}.via: must be a string or array`);
}

const VALID_OS_PLATFORMS: OsPlatform[] = ['linux', 'mac', 'windows'];

function parseCondition(raw: unknown, loc: string): Condition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${loc}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set(['os', 'exists', 'exec', 'target_exists', 'not']);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new Error(`${loc}: unknown key "${key}"`);
    }
  }
  const cond: Condition = {};
  if (obj['os'] !== undefined) {
    const platforms = Array.isArray(obj['os']) ? obj['os'] : [obj['os']];
    for (const p of platforms) {
      if (!VALID_OS_PLATFORMS.includes(p as OsPlatform)) {
        throw new Error(
          `${loc}.os: must be one of ${VALID_OS_PLATFORMS.join(', ')}, got "${p}"`,
        );
      }
    }
    cond.os = Array.isArray(obj['os'])
      ? (obj['os'] as OsPlatform[])
      : (obj['os'] as OsPlatform);
  }
  if (obj['exists'] !== undefined) {
    if (typeof obj['exists'] !== 'string' || !obj['exists']) {
      throw new Error(`${loc}.exists: must be a non-empty string`);
    }
    cond.exists = obj['exists'];
  }
  if (obj['exec'] !== undefined) {
    if (typeof obj['exec'] !== 'string' || !obj['exec']) {
      throw new Error(`${loc}.exec: must be a non-empty string`);
    }
    cond.exec = obj['exec'];
  }
  if (obj['target_exists'] !== undefined) {
    if (typeof obj['target_exists'] !== 'boolean') {
      throw new Error(`${loc}.target_exists: must be a boolean`);
    }
    cond.target_exists = obj['target_exists'];
  }
  if (obj['not'] !== undefined) {
    if (typeof obj['not'] !== 'boolean') {
      throw new Error(`${loc}.not: must be a boolean`);
    }
    cond.not = obj['not'];
  }
  return cond;
}

function parseConditionField(
  obj: Record<string, unknown>,
  loc: string,
): { if?: Condition | Condition[]; ifAny?: Condition[] } {
  const result: { if?: Condition | Condition[]; ifAny?: Condition[] } = {};
  if (obj['if'] !== undefined) {
    if (Array.isArray(obj['if'])) {
      result['if'] = (obj['if'] as unknown[]).map((c, i) =>
        parseCondition(c, `${loc}.if[${i}]`),
      );
    } else {
      result['if'] = parseCondition(obj['if'], `${loc}.if`);
    }
  }
  if (obj['ifAny'] !== undefined) {
    if (!Array.isArray(obj['ifAny'])) {
      throw new Error(`${loc}.ifAny: must be an array`);
    }
    result.ifAny = (obj['ifAny'] as unknown[]).map((c, i) =>
      parseCondition(c, `${loc}.ifAny[${i}]`),
    );
  }
  return result;
}

function parseSingleSrc(raw: unknown, loc: string): FileSrc {
  // Plain string → http/https URL or local path
  if (typeof raw === 'string') {
    return raw;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${loc}: must be a string or a map with one of: path, url, exec, gitlab, github, bitbucket, git, aws_s3, vault, http, raw, aws_secrets_manager, aws_systems_manager_parameter`,
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
    const pathConds = parseConditionField(obj, loc);
    if (pathConds['if'] !== undefined) result['if'] = pathConds['if'];
    if (pathConds.ifAny !== undefined) result.ifAny = pathConds.ifAny;
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
    if (!obj['url'].includes('$') && isGitRemoteUrl(obj['url'])) {
      try {
        parseGitRemoteSpec(obj['url']);
      } catch (err) {
        throw new Error(
          `${loc}.url: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
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
    const urlConds = parseConditionField(obj, loc);
    if (urlConds['if'] !== undefined) result['if'] = urlConds['if'];
    if (urlConds.ifAny !== undefined) result.ifAny = urlConds.ifAny;
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
    const httpConds = parseConditionField(obj, loc);
    if (httpConds['if'] !== undefined) result['if'] = httpConds['if'];
    if (httpConds.ifAny !== undefined) result.ifAny = httpConds.ifAny;
    return result;
  }

  if ('exec' in obj) {
    if (typeof obj['exec'] !== 'string' || !obj['exec']) {
      throw new Error(`${loc}.exec: must be a non-empty string`);
    }
    const result = { exec: obj['exec'] } as ExecSrc;
    const execSha = parseSha(obj['sha'], loc);
    if (execSha !== undefined) result.sha = execSha;
    const execConds = parseConditionField(obj, loc);
    if (execConds['if'] !== undefined) result['if'] = execConds['if'];
    if (execConds.ifAny !== undefined) result.ifAny = execConds.ifAny;
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
    const gitlabConds = parseConditionField(obj, loc);
    return {
      gitlab: {
        project: g['project'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.gitlab`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
        via: parseVia(g['via'], `${loc}.gitlab`),
      },
      ...gitlabConds,
    };
  }

  if ('raw' in obj) {
    if (typeof obj['raw'] !== 'string') {
      throw new Error(`${loc}.raw: must be a string`);
    }
    const rawConds = parseConditionField(obj, loc);
    return { raw: obj['raw'], ...rawConds };
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
    const githubConds = parseConditionField(obj, loc);
    return {
      github: {
        repo: g['repo'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.github`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
        via: parseVia(g['via'], `${loc}.github`),
      },
      ...githubConds,
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
    const bitbucketConds = parseConditionField(obj, loc);
    return {
      bitbucket: {
        workspace: b['workspace'],
        repo: b['repo'],
        file: b['file'],
        ref: typeof b['ref'] === 'string' ? b['ref'] : undefined,
        sha: parseSha(b['sha'], `${loc}.bitbucket`),
        host: typeof b['host'] === 'string' ? b['host'] : undefined,
      },
      ...bitbucketConds,
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
    const gitConds = parseConditionField(obj, loc);
    return {
      git: {
        repo: gt['repo'],
        file: gt['file'],
        ref: typeof gt['ref'] === 'string' ? gt['ref'] : undefined,
        sha: parseSha(gt['sha'], `${loc}.git`),
      },
      ...gitConds,
    };
  }

  if ('aws_s3' in obj) {
    if (typeof obj['aws_s3'] !== 'string' || !obj['aws_s3']) {
      throw new Error(`${loc}.aws_s3: must be a non-empty string (s3:// URI)`);
    }
    const result = { aws_s3: obj['aws_s3'] } as AwsS3Src;
    const s3Sha = parseSha(obj['sha'], loc);
    if (s3Sha !== undefined) result.sha = s3Sha;
    const s3Conds = parseConditionField(obj, loc);
    if (s3Conds['if'] !== undefined) result['if'] = s3Conds['if'];
    if (s3Conds.ifAny !== undefined) result.ifAny = s3Conds.ifAny;
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
    const vaultConds = parseConditionField(obj, loc);
    return {
      vault: {
        path: vt['path'],
        field: typeof vt['field'] === 'string' ? vt['field'] : undefined,
        sha: parseSha(vt['sha'], `${loc}.vault`),
      },
      ...vaultConds,
    };
  }

  if ('aws_secrets_manager' in obj) {
    const sm = obj['aws_secrets_manager'];
    if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
      throw new Error(`${loc}.aws_secrets_manager: must be an object`);
    }
    const smt = sm as Record<string, unknown>;
    if (typeof smt['name'] !== 'string' || !smt['name']) {
      throw new Error(`${loc}.aws_secrets_manager.name: required string`);
    }
    const smConds = parseConditionField(obj, loc);
    return {
      aws_secrets_manager: {
        name: smt['name'],
        key:
          typeof smt['key'] === 'string' && smt['key'] ? smt['key'] : undefined,
        region:
          typeof smt['region'] === 'string' && smt['region']
            ? smt['region']
            : undefined,
        sha: parseSha(smt['sha'], `${loc}.aws_secrets_manager`),
      },
      ...smConds,
    };
  }

  if ('aws_systems_manager_parameter' in obj) {
    const ssm = obj['aws_systems_manager_parameter'];
    if (!ssm || typeof ssm !== 'object' || Array.isArray(ssm)) {
      throw new Error(
        `${loc}.aws_systems_manager_parameter: must be an object`,
      );
    }
    const ssmt = ssm as Record<string, unknown>;
    if (typeof ssmt['name'] !== 'string' || !ssmt['name']) {
      throw new Error(
        `${loc}.aws_systems_manager_parameter.name: required string`,
      );
    }
    const ssmConds = parseConditionField(obj, loc);
    return {
      aws_systems_manager_parameter: {
        name: ssmt['name'],
        region:
          typeof ssmt['region'] === 'string' && ssmt['region']
            ? ssmt['region']
            : undefined,
        sha: parseSha(ssmt['sha'], `${loc}.aws_systems_manager_parameter`),
      },
      ...ssmConds,
    };
  }

  throw new Error(
    `${loc}: unknown source type. Must be a string or map with exec/gitlab/github/bitbucket/git/aws_s3/vault/http/url/path/raw/aws_secrets_manager/aws_systems_manager_parameter`,
  );
}

function parseMergeOptions<
  C extends string,
  A extends string,
  O extends string,
>(
  raw: unknown,
  loc: string,
  kind: string,
  conflictValues: C[],
  arrayValues: A[],
  objectValues: O[],
): { conflicts?: C; arrays?: A; objects?: O } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${loc}: "${kind}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const opts: { conflicts?: C; arrays?: A; objects?: O } = {};

  if (obj['conflicts'] !== undefined) {
    if (!conflictValues.includes(obj['conflicts'] as C)) {
      throw new Error(
        `${loc}.${kind}.conflicts: must be one of ${conflictValues.join(', ')}`,
      );
    }
    opts.conflicts = obj['conflicts'] as C;
  }

  if (obj['arrays'] !== undefined) {
    if (!arrayValues.includes(obj['arrays'] as A)) {
      throw new Error(
        `${loc}.${kind}.arrays: must be one of ${arrayValues.join(', ')}`,
      );
    }
    opts.arrays = obj['arrays'] as A;
  }

  if (obj['objects'] !== undefined) {
    if (!objectValues.includes(obj['objects'] as O)) {
      throw new Error(
        `${loc}.${kind}.objects: must be one of ${objectValues.join(', ')}`,
      );
    }
    opts.objects = obj['objects'] as O;
  }

  return opts;
}

function parseJsonMergeOptions(raw: unknown, loc: string): JsonMergeOptions {
  const opts: JsonMergeOptions = parseMergeOptions<
    JsonConflictStrategy,
    JsonArrayStrategy,
    JsonObjectStrategy
  >(
    raw,
    loc,
    'json',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat'],
    ['replace', 'merge'],
  );

  const r = raw as Record<string, unknown>;

  if ('indent' in r) {
    const v = r['indent'];
    if (v === 'tab') {
      opts.indent = 'tab';
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      opts.indent = v;
    } else {
      throw new Error(
        `${loc}.json.indent: must be a non-negative integer or "tab"`,
      );
    }
  }

  for (const [yamlKey, tsKey] of [
    ['trailing_commas', 'trailingCommas'],
    ['sort_keys', 'sortKeys'],
    ['minify', 'minify'],
    ['strip_comments', 'stripComments'],
  ] as const) {
    if (yamlKey in r) {
      if (typeof r[yamlKey] !== 'boolean') {
        throw new Error(`${loc}.json.${yamlKey}: must be a boolean`);
      }
      (opts as Record<string, unknown>)[tsKey] = r[yamlKey];
    }
  }

  return opts;
}

function parseYamlMergeOptions(raw: unknown, loc: string): YamlMergeOptions {
  return parseMergeOptions<
    YamlConflictStrategy,
    YamlArrayStrategy,
    YamlObjectStrategy
  >(
    raw,
    loc,
    'yaml',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat'],
    ['replace', 'merge'],
  );
}

function parseTomlMergeOptions(raw: unknown, loc: string): TomlMergeOptions {
  return parseMergeOptions<
    TomlConflictStrategy,
    TomlArrayStrategy,
    TomlObjectStrategy
  >(
    raw,
    loc,
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
