import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { FileFerryConfig, FileEntry, FileSrc, ReplaceRule } from './types';

const CONFIG_CANDIDATES = [
  '.avanti.yml',
  '.avanti.yaml',
  'avanti.yml',
  'avanti.yaml',
];

export function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);

  const cwd = process.cwd();
  const entries = fs.readdirSync(cwd);
  const lowerEntries = entries.map((e) => e.toLowerCase());

  for (const candidate of CONFIG_CANDIDATES) {
    const idx = lowerEntries.indexOf(candidate);
    if (idx !== -1) return path.resolve(cwd, entries[idx]);
  }

  return path.resolve(cwd, CONFIG_CANDIDATES[0]);
}

export function loadConfig(configPath: string): FileFerryConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
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

    return fileEntry;
  });

  return { files };
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
