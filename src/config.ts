import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  FileFerryConfig,
  FileEntry,
  FileSrc,
  JsonArrayStrategy,
  JsonConflictStrategy,
  JsonMergeOptions,
  JsonObjectStrategy,
  ReplaceRule,
  Variables,
} from './types';
import { validateVariables } from './variables';
import { fetchHttp } from './sources/http';
import { fetchGitHub } from './sources/github';
import { fetchGitLab } from './sources/gitlab';

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
    s.startsWith('github:') ||
    s.startsWith('gitlab:')
  );
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
    return fetchHttp(spec);
  }

  if (spec.startsWith('github:')) {
    const { repo, file, ref } = parseGitHubSpec(spec);
    const result = await fetchGitHub(repo, file, ref);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return result.files.values().next().value as string;
  }

  if (spec.startsWith('gitlab:')) {
    const { project, file, ref } = parseGitLabSpec(spec);
    const result = await fetchGitLab(project, file, ref);
    if (result.files.size !== 1) {
      throw new Error(
        `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
      );
    }
    return result.files.values().next().value as string;
  }

  // Local file
  if (!fs.existsSync(spec)) {
    throw new Error(`Config file not found: ${spec}`);
  }
  return fs.readFileSync(spec, 'utf8');
}

export async function loadConfig(configPath: string): Promise<FileFerryConfig> {
  let raw: unknown;
  try {
    const content = await fetchConfigContent(configPath);
    raw = yaml.load(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a YAML object');
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj['files'])) {
    throw new Error('Config must have a "files" array');
  }

  const variables = parseVariables(obj['variables']);

  const files: FileEntry[] = (obj['files'] as unknown[]).map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`files[${i}]: must be an object`);
    }
    const e = entry as Record<string, unknown>;

    if (e['src'] === undefined || e['src'] === null) {
      throw new Error(`files[${i}]: "src" is required`);
    }

    const src = Array.isArray(e['src'])
      ? (e['src'] as unknown[]).map((item, j) => parseSingleSrc(item, i, j))
      : parseSingleSrc(e['src'], i, undefined);

    // list src must have an explicit target
    if (Array.isArray(src) && !e['target']) {
      throw new Error(`files[${i}]: "target" is required when "src" is a list`);
    }

    // exec/raw sources must have a target
    if (
      !Array.isArray(src) &&
      (isExecSrc(src) || isRawSrc(src)) &&
      !e['target']
    ) {
      throw new Error(`files[${i}]: "target" is required for exec/raw sources`);
    }

    const fileEntry: FileEntry = { src };

    if (typeof e['target'] === 'string') fileEntry.target = e['target'];
    if (typeof e['mode'] === 'string') fileEntry.mode = e['mode'];
    if (typeof e['post'] === 'string') fileEntry.post = e['post'];

    if (e['replace'] !== undefined) {
      if (!Array.isArray(e['replace'])) {
        throw new Error(`files[${i}]: "replace" must be an array`);
      }
      fileEntry.replace = (e['replace'] as unknown[]).map((r, j) =>
        parseReplaceRule(r, i, j),
      );
    }

    if (e['json'] !== undefined) {
      const rawJson = e['json'];
      if (rawJson === true || rawJson === false) {
        fileEntry.json = rawJson;
      } else {
        fileEntry.json = parseJsonMergeOptions(rawJson, i);
      }
    }

    return fileEntry;
  });

  return { variables, files };
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

function parseSingleSrc(
  raw: unknown,
  i: number,
  j: number | undefined,
): FileSrc {
  const loc = j !== undefined ? `files[${i}].src[${j}]` : `files[${i}].src`;

  // Plain string → http/https URL or local path
  if (typeof raw === 'string') {
    return raw;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${loc}: must be a string or a map with one of: exec, gitlab, github`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if ('exec' in obj) {
    if (typeof obj['exec'] !== 'string' || !obj['exec']) {
      throw new Error(`${loc}.exec: must be a non-empty string`);
    }
    return { exec: obj['exec'] };
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
    return {
      gitlab: {
        project: g['project'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
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
    return {
      github: {
        repo: g['repo'],
        file: g['file'],
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
      },
    };
  }

  throw new Error(
    `${loc}: unknown source type. Must be a string or map with exec/gitlab/github/raw`,
  );
}

function isExecSrc(src: FileSrc): boolean {
  return typeof src === 'object' && 'exec' in src;
}

function isRawSrc(src: FileSrc): boolean {
  return typeof src === 'object' && 'raw' in src;
}

function parseJsonMergeOptions(raw: unknown, i: number): JsonMergeOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`files[${i}]: "json" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const opts: JsonMergeOptions = {};

  const conflictValues: JsonConflictStrategy[] = [
    'abort',
    'first_wins',
    'last_wins',
  ];
  if (obj['conflicts'] !== undefined) {
    if (!conflictValues.includes(obj['conflicts'] as JsonConflictStrategy)) {
      throw new Error(
        `files[${i}].json.conflicts: must be one of ${conflictValues.join(', ')}`,
      );
    }
    opts.conflicts = obj['conflicts'] as JsonConflictStrategy;
  }

  const arrayValues: JsonArrayStrategy[] = ['replace', 'concat'];
  if (obj['arrays'] !== undefined) {
    if (!arrayValues.includes(obj['arrays'] as JsonArrayStrategy)) {
      throw new Error(
        `files[${i}].json.arrays: must be one of ${arrayValues.join(', ')}`,
      );
    }
    opts.arrays = obj['arrays'] as JsonArrayStrategy;
  }

  const objectValues: JsonObjectStrategy[] = ['replace', 'merge'];
  if (obj['objects'] !== undefined) {
    if (!objectValues.includes(obj['objects'] as JsonObjectStrategy)) {
      throw new Error(
        `files[${i}].json.objects: must be one of ${objectValues.join(', ')}`,
      );
    }
    opts.objects = obj['objects'] as JsonObjectStrategy;
  }

  return opts;
}

function parseReplaceRule(r: unknown, i: number, j: number): ReplaceRule {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error(`files[${i}].replace[${j}]: must be an object`);
  }
  const rule = r as Record<string, unknown>;
  if (typeof rule['from'] !== 'string') {
    throw new Error(`files[${i}].replace[${j}]: "from" must be a string`);
  }
  if (typeof rule['to'] !== 'string') {
    throw new Error(`files[${i}].replace[${j}]: "to" must be a string`);
  }
  return { from: rule['from'], to: rule['to'] };
}
