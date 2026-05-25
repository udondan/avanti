import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parseDocument, isMap, isScalar } from 'yaml';
import {
  AvantiConfig,
  AwsS3Src,
  Condition,
  ExecSrc,
  OnHooks,
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
  IniArrayStrategy,
  IniConflictStrategy,
  IniMergeOptions,
  IniObjectStrategy,
  ReplaceRule,
  TemplateEngine,
  VALID_TEMPLATE_ENGINES,
  VariableEntry,
  VariableSpec,
  VariableValue,
  Via,
} from './types';
import { validateVariables } from './variables';
import { expandBraces } from './paths';
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

function isLocalFileSrc(src: FileSrc): boolean {
  if (typeof src === 'string') {
    return (
      !src.startsWith('http://') &&
      !src.startsWith('https://') &&
      !isGitRemoteUrl(src) &&
      !src.startsWith('exec:') &&
      !src.startsWith('github:') &&
      !src.startsWith('gitlab:') &&
      !src.startsWith('raw:') &&
      !src.startsWith('s3://') &&
      !src.startsWith('ssh://') &&
      !src.startsWith('git+')
    );
  }
  return 'path' in src;
}

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
  // Normalize YAML 0o-prefixed octal literals in files[*].mode before js-yaml
  // parses the content. js-yaml discards the 0o prefix, turning e.g. 0o644
  // into integer 420. We use the yaml package's AST to locate only actual
  // files[*].mode scalar values (never block-scalar content or other fields),
  // then do a targeted string replacement at the exact character range.
  try {
    const doc = parseDocument(content);
    const filesNode = doc.get('files', true);
    if (isMap(filesNode)) {
      const replacements: Array<{ start: number; end: number; text: string }> =
        [];
      for (const pair of filesNode.items) {
        const entryNode = (pair as { value?: unknown }).value;
        if (!isMap(entryNode)) continue;
        const modeNode = entryNode.get('mode', true);
        if (
          isScalar(modeNode) &&
          typeof modeNode.value === 'number' &&
          Number.isInteger(modeNode.value) &&
          modeNode.range
        ) {
          const raw = content.slice(modeNode.range[0], modeNode.range[1]);
          if (raw.startsWith('0o')) {
            const digits = raw.slice(2);
            replacements.push({
              start: modeNode.range[0],
              end: modeNode.range[1],
              text: `"${digits.padStart(4, '0')}"`,
            });
          }
        }
      }
      // Apply in reverse order so earlier offsets stay valid.
      for (const r of replacements.reverse()) {
        content = content.slice(0, r.start) + r.text + content.slice(r.end);
      }
    }
  } catch {
    // If AST parse fails, fall through to js-yaml which will produce its own
    // error with better context.
  }

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
  const fileOrigins: Record<string, string> = Object.create(null) as Record<
    string,
    string
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

    if (typeof e['mode'] === 'number') {
      // 0o-prefixed YAML literals are normalized to quoted strings before parsing
      // (see preprocessing above), so any remaining number is a bare decimal like
      // mode: 755, which is ambiguous and rejected.
      throw new Error(
        `files["${target}"].mode: ${e['mode']} is a bare decimal — use a quoted string like "0755" or YAML 0o notation (e.g. 0o755)`,
      );
    } else if (typeof e['mode'] === 'string') {
      if (!/^[0-7]{1,4}$/.test(e['mode'])) {
        throw new Error(
          `files["${target}"].mode: "${e['mode']}" is not a valid octal string (expected 1–4 octal digits, e.g. "0755")`,
        );
      }
      fileEntry.mode = e['mode'];
    }
    if (typeof e['backup'] === 'string') fileEntry.backup = e['backup'];
    if (e['post'] !== undefined) {
      throw new Error(
        `files["${target}"].post: removed — use on.write instead`,
      );
    }
    if (e['on'] !== undefined) {
      if (
        typeof e['on'] !== 'object' ||
        e['on'] === null ||
        Array.isArray(e['on']) ||
        (Object.getPrototypeOf(e['on']) !== Object.prototype &&
          Object.getPrototypeOf(e['on']) !== null)
      ) {
        throw new Error(`files["${target}"].on: must be a mapping`);
      }
      const validKeys = new Set<keyof OnHooks>([
        'write',
        'beforeWrite',
        'beforeCreate',
        'beforeUpdate',
        'create',
        'update',
      ]);
      const onObj = e['on'] as Record<string, unknown>;
      const onHooks: OnHooks = Object.create(null) as OnHooks;
      for (const key of Object.keys(onObj)) {
        if (!validKeys.has(key as keyof OnHooks)) {
          throw new Error(`files["${target}"].on: unknown key "${key}"`);
        }
        if (typeof onObj[key] !== 'string') {
          throw new Error(`files["${target}"].on.${key}: must be a string`);
        }
        onHooks[key as keyof OnHooks] = onObj[key];
      }
      fileEntry.on = onHooks;
    }
    if (typeof e['writeInPlace'] === 'boolean')
      fileEntry.writeInPlace = e['writeInPlace'];
    if (typeof e['followSymlink'] === 'boolean')
      fileEntry.followSymlink = e['followSymlink'];
    if (e['symlink'] !== undefined) {
      if (
        e['symlink'] !== true &&
        e['symlink'] !== 'absolute' &&
        e['symlink'] !== 'relative'
      ) {
        throw new Error(
          `files["${target}"].symlink: must be true, "absolute", or "relative"`,
        );
      }
      fileEntry.symlink = e['symlink'];
    }
    if (e['sudo'] !== undefined) {
      if (e['sudo'] === true) {
        fileEntry.sudo = true;
      } else if (typeof e['sudo'] === 'string' && e['sudo'].trim()) {
        if (e['sudo'].trim().startsWith('-')) {
          throw new Error(
            `files["${target}"].sudo: username must not start with '-'`,
          );
        }
        fileEntry.sudo = e['sudo'].trim();
      } else if (e['sudo'] !== false) {
        throw new Error(
          `files["${target}"].sudo: must be true or a non-empty username string`,
        );
      }
    }
    if (e['strategy'] !== undefined) {
      if (e['strategy'] !== 'replace' && e['strategy'] !== 'insert') {
        throw new Error(
          `files["${target}"].strategy: must be "replace" or "insert"`,
        );
      }
      fileEntry.strategy = e['strategy'];
    }
    if (fileEntry.strategy === 'insert' && fileEntry.sudo) {
      throw new Error(
        `files["${target}"]: strategy "insert" cannot be combined with sudo — ` +
          `insert mode reads the existing file without privilege escalation, ` +
          `which silently treats an unreadable privileged file as absent. ` +
          `Use a non-insert strategy, or manage the file without sudo.`,
      );
    }

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

    if (e['ini'] !== undefined) {
      const rawIni = e['ini'];
      if (rawIni === true || rawIni === false) {
        fileEntry.ini = rawIni;
      } else {
        fileEntry.ini = parseIniMergeOptions(rawIni, `files["${target}"]`);
      }
    }

    if (e['template'] !== undefined) {
      const rawTemplate = e['template'];
      if (rawTemplate === true) {
        fileEntry.template = true;
      } else {
        if (
          typeof rawTemplate !== 'string' ||
          !VALID_TEMPLATE_ENGINES.includes(rawTemplate as TemplateEngine)
        ) {
          throw new Error(
            `files["${target}"].template: must be true or one of ${VALID_TEMPLATE_ENGINES.join(', ')}`,
          );
        }
        fileEntry.template = rawTemplate as TemplateEngine;
      }
    }

    if (e['extract'] !== undefined) {
      if (Array.isArray(src)) {
        throw new Error(
          `files["${target}"].extract: cannot be used with a list of sources`,
        );
      }
      if (!target.endsWith('/') && !target.endsWith(path.sep)) {
        throw new Error(
          `files["${target}"].extract: target must be a directory (end with "/") — archive extraction writes multiple files`,
        );
      }
      const rawExtract = e['extract'];
      if (rawExtract === true) {
        fileEntry.extract = true;
      } else if (Array.isArray(rawExtract)) {
        if (rawExtract.length === 0) {
          throw new Error(
            `files["${target}"].extract: must not be an empty array`,
          );
        }
        fileEntry.extract = (rawExtract as unknown[]).map((pat, i) => {
          if (typeof pat !== 'string' || !pat) {
            throw new Error(
              `files["${target}"].extract[${i}]: must be a non-empty string`,
            );
          }
          if (pat.length > 2 && pat.startsWith('/') && pat.endsWith('/')) {
            try {
              new RegExp(pat.slice(1, -1));
            } catch (err) {
              throw new Error(
                `files["${target}"].extract[${i}]: invalid regex`,
                { cause: err },
              );
            }
          }
          return pat;
        });
      } else {
        throw new Error(
          `files["${target}"].extract: must be true or a non-empty array of patterns`,
        );
      }
    }

    if (fileEntry.symlink) {
      if (target === SELF_KEY) {
        throw new Error(
          `files["${SELF_KEY}"].symlink: $self cannot be a symlink entry`,
        );
      }
      if (Array.isArray(fileEntry.src)) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with a list of sources`,
        );
      }
      if (!isLocalFileSrc(fileEntry.src)) {
        throw new Error(
          `files["${target}"].symlink: src must be a local path — ` +
            `http, exec, github, gitlab, and other remote sources are not supported`,
        );
      }
      if (typeof fileEntry.src !== 'string' && 'path' in fileEntry.src) {
        const localSrc = fileEntry.src;
        if (localSrc.sha) {
          throw new Error(
            `files["${target}"].symlink: cannot be combined with src.sha`,
          );
        }
        if (localSrc.filter) {
          throw new Error(
            `files["${target}"].symlink: cannot be combined with src.filter`,
          );
        }
        if (localSrc.if) {
          throw new Error(
            `files["${target}"].symlink: cannot be combined with src.if`,
          );
        }
        if (localSrc.ifAny) {
          throw new Error(
            `files["${target}"].symlink: cannot be combined with src.ifAny`,
          );
        }
      }
      if (fileEntry.replace) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with replace:`,
        );
      }
      if (fileEntry.template) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with template:`,
        );
      }
      if (fileEntry.json) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with json:`,
        );
      }
      if (fileEntry.yaml) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with yaml:`,
        );
      }
      if (fileEntry.toml) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with toml:`,
        );
      }
      if (fileEntry.ini) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with ini:`,
        );
      }
      if (fileEntry.on?.write) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with on.write:`,
        );
      }
      if (fileEntry.extract) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with extract:`,
        );
      }
      if (fileEntry.writeInPlace) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with writeInPlace:`,
        );
      }
      if (fileEntry.strategy) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with strategy:`,
        );
      }
      if (fileEntry.followSymlink) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with followSymlink:`,
        );
      }
      if (fileEntry.mode) {
        throw new Error(
          `files["${target}"].symlink: cannot be combined with mode — symlinks do not have independent permission bits on POSIX`,
        );
      }
    }

    let expandedTargets: string[];
    try {
      expandedTargets = expandBraces(target);
    } catch (err) {
      throw new Error(
        `files["${target}"]: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    for (const expandedTarget of expandedTargets) {
      if (expandedTarget in files) {
        const parts: string[] = [];
        if (expandedTarget !== target) {
          parts.push(`expanded from "${target}"`);
        }
        const existingOrigin = fileOrigins[expandedTarget];
        if (existingOrigin !== undefined && existingOrigin !== target) {
          parts.push(`existing entry expanded from "${existingOrigin}"`);
        }
        const suffix = parts.length > 0 ? ` (${parts.join('; ')})` : '';
        throw new Error(
          `files["${expandedTarget}"]: duplicate target${suffix}`,
        );
      }
      files[expandedTarget] = { ...fileEntry, target: expandedTarget };
      if (expandedTarget !== target) {
        fileOrigins[expandedTarget] = target;
      }
    }
  }

  let backup_roots: string[] | undefined;
  if (obj['backup_roots'] !== undefined) {
    if (
      !Array.isArray(obj['backup_roots']) ||
      !(obj['backup_roots'] as unknown[]).every((r) => typeof r === 'string')
    ) {
      throw new Error('"backup_roots" must be a list of strings');
    }
    backup_roots = obj['backup_roots'] as string[];
  }

  return { variables, backup_roots, files };
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

// Recursively assert that a value is a valid JsonValue — no class instances
// (e.g. Date from js-yaml timestamp parsing) anywhere in the tree.
function assertPlainJsonValue(val: unknown, path: string): void {
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      assertPlainJsonValue(val[i], `${path}[${i}]`);
    }
    return;
  }
  const proto = Object.getPrototypeOf(val) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const name =
      (val as { constructor?: { name?: string } }).constructor?.name ??
      'unknown';
    throw new Error(
      `${path}: expected a plain object but got ${name} — quote YAML timestamps and other special values`,
    );
  }
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const keyPart = /[.[\]"']/.test(k)
      ? `["${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
      : `.${k}`;
    assertPlainJsonValue(v, `${path}${keyPart}`);
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
      Object.hasOwn(val, 'src')
    ) {
      // `src` is a reserved key: any object with a top-level `src` key is
      // treated as a source-backed VariableEntry, not a plain data object.
      spec[key] = parseVariableEntry(
        val as unknown as Record<string, unknown>,
        key,
      );
    } else if (
      Array.isArray(val) ||
      typeof val === 'number' ||
      typeof val === 'boolean'
    ) {
      assertPlainJsonValue(val, `variables.${key}`);
      spec[key] = val as VariableValue;
    } else if (typeof val === 'object' && val !== null) {
      assertPlainJsonValue(val, `variables.${key}`);
      spec[key] = val as VariableValue;
    } else {
      throw new Error(
        `variables.${key}: value must be a string, number, boolean, list, object, or source object with "src"`,
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

  if (obj['ini'] !== undefined) {
    const rawIni = obj['ini'];
    if (rawIni === true || rawIni === false) {
      entry.ini = rawIni;
    } else {
      entry.ini = parseIniMergeOptions(rawIni, loc);
    }
  }

  if (obj['template'] !== undefined) {
    const rawTemplate = obj['template'];
    if (rawTemplate === true) {
      entry.template = true;
    } else {
      if (
        typeof rawTemplate !== 'string' ||
        !VALID_TEMPLATE_ENGINES.includes(rawTemplate as TemplateEngine)
      ) {
        throw new Error(
          `${loc}.template: must be true or one of ${VALID_TEMPLATE_ENGINES.join(', ')}`,
        );
      }
      entry.template = rawTemplate as TemplateEngine;
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

const VALID_OS_PLATFORMS: OsPlatform[] = [
  'linux',
  'mac',
  'windows',
  'darwin',
  'win32',
];

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
  const checkKeys = ['os', 'exists', 'exec', 'target_exists'] as const;
  if (!checkKeys.some((k) => obj[k] !== undefined)) {
    throw new Error(
      `${loc}: must specify at least one of ${checkKeys.join(', ')}`,
    );
  }
  const cond: Condition = {};
  if (obj['os'] !== undefined) {
    if (Array.isArray(obj['os']) && obj['os'].length === 0) {
      throw new Error(`${loc}.os: must not be an empty array`);
    }
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
      if (obj['if'].length === 0) {
        throw new Error(`${loc}.if: must not be an empty array`);
      }
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
    if (obj['ifAny'].length === 0) {
      throw new Error(`${loc}.ifAny: must not be an empty array`);
    }
    result.ifAny = (obj['ifAny'] as unknown[]).map((c, i) =>
      parseCondition(c, `${loc}.ifAny[${i}]`),
    );
  }
  return result;
}

function parseFilter(
  obj: Record<string, unknown>,
  loc: string,
): string[] | undefined {
  if (obj['filter'] === undefined) return undefined;
  if (!Array.isArray(obj['filter'])) {
    throw new Error(`${loc}.filter: must be an array`);
  }
  if (obj['filter'].length === 0) {
    throw new Error(`${loc}.filter: must not be an empty array`);
  }
  return (obj['filter'] as unknown[]).map((entry, i) => {
    if (typeof entry !== 'string' || !entry) {
      throw new Error(`${loc}.filter[${i}]: must be a non-empty string`);
    }
    if (entry.length > 2 && entry.startsWith('/') && entry.endsWith('/')) {
      try {
        new RegExp(entry.slice(1, -1));
      } catch (err) {
        throw new Error(
          `${loc}.filter[${i}]: invalid regex: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    return entry;
  });
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
    const pathFilter = parseFilter(obj, loc);
    if (pathFilter !== undefined) result.filter = pathFilter;
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
    if (
      g['file'] !== undefined &&
      (typeof g['file'] !== 'string' || !g['file'])
    ) {
      throw new Error(`${loc}.gitlab.file: must be a non-empty string`);
    }
    if (
      g['release'] !== undefined &&
      (typeof g['release'] !== 'string' || !g['release'])
    ) {
      throw new Error(`${loc}.gitlab.release: must be a non-empty string`);
    }
    const hasFile = typeof g['file'] === 'string' && !!g['file'];
    const hasRelease = typeof g['release'] === 'string' && !!g['release'];
    if (hasFile && hasRelease) {
      throw new Error(
        `${loc}.gitlab: "file" and "release" are mutually exclusive`,
      );
    }
    if (!hasFile && !hasRelease) {
      throw new Error(`${loc}.gitlab: one of "file" or "release" is required`);
    }
    if (hasRelease && g['ref'] !== undefined) {
      throw new Error(`${loc}.gitlab: "ref" is not valid when using "release"`);
    }
    if (
      g['host'] !== undefined &&
      (typeof g['host'] !== 'string' || !g['host'].trim())
    ) {
      throw new Error(`${loc}.gitlab.host: must be a non-empty string`);
    }
    const gitlabConds = parseConditionField(obj, loc);
    const gitlabFilter = parseFilter(obj, loc);
    if (hasRelease) {
      return {
        gitlab: {
          project: g['project'],
          release: g['release'] as string,
          sha: parseSha(g['sha'], `${loc}.gitlab`),
          host: typeof g['host'] === 'string' ? g['host'] : undefined,
          via: parseVia(g['via'], `${loc}.gitlab`),
        },
        ...(gitlabFilter !== undefined ? { filter: gitlabFilter } : {}),
        ...gitlabConds,
      };
    }
    return {
      gitlab: {
        project: g['project'],
        file: g['file'] as string,
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.gitlab`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
        via: parseVia(g['via'], `${loc}.gitlab`),
      },
      ...(gitlabFilter !== undefined ? { filter: gitlabFilter } : {}),
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
    if (
      g['file'] !== undefined &&
      (typeof g['file'] !== 'string' || !g['file'])
    ) {
      throw new Error(`${loc}.github.file: must be a non-empty string`);
    }
    if (
      g['release'] !== undefined &&
      (typeof g['release'] !== 'string' || !g['release'])
    ) {
      throw new Error(`${loc}.github.release: must be a non-empty string`);
    }
    const hasFile = typeof g['file'] === 'string' && !!g['file'];
    const hasRelease = typeof g['release'] === 'string' && !!g['release'];
    if (hasFile && hasRelease) {
      throw new Error(
        `${loc}.github: "file" and "release" are mutually exclusive`,
      );
    }
    if (!hasFile && !hasRelease) {
      throw new Error(`${loc}.github: one of "file" or "release" is required`);
    }
    if (hasRelease && g['ref'] !== undefined) {
      throw new Error(`${loc}.github: "ref" is not valid when using "release"`);
    }
    if (
      g['host'] !== undefined &&
      (typeof g['host'] !== 'string' || !g['host'].trim())
    ) {
      throw new Error(`${loc}.github.host: must be a non-empty string`);
    }
    const githubConds = parseConditionField(obj, loc);
    const githubFilter = parseFilter(obj, loc);
    if (hasRelease) {
      return {
        github: {
          repo: g['repo'],
          release: g['release'] as string,
          sha: parseSha(g['sha'], `${loc}.github`),
          host: typeof g['host'] === 'string' ? g['host'] : undefined,
          via: parseVia(g['via'], `${loc}.github`),
        },
        ...(githubFilter !== undefined ? { filter: githubFilter } : {}),
        ...githubConds,
      };
    }
    return {
      github: {
        repo: g['repo'],
        file: g['file'] as string,
        ref: typeof g['ref'] === 'string' ? g['ref'] : undefined,
        sha: parseSha(g['sha'], `${loc}.github`),
        host: typeof g['host'] === 'string' ? g['host'] : undefined,
        via: parseVia(g['via'], `${loc}.github`),
      },
      ...(githubFilter !== undefined ? { filter: githubFilter } : {}),
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
    const bitbucketFilter = parseFilter(obj, loc);
    return {
      bitbucket: {
        workspace: b['workspace'],
        repo: b['repo'],
        file: b['file'],
        ref: typeof b['ref'] === 'string' ? b['ref'] : undefined,
        sha: parseSha(b['sha'], `${loc}.bitbucket`),
        host: typeof b['host'] === 'string' ? b['host'] : undefined,
      },
      ...(bitbucketFilter !== undefined ? { filter: bitbucketFilter } : {}),
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
    const gitFilter = parseFilter(obj, loc);
    return {
      git: {
        repo: gt['repo'],
        file: gt['file'],
        ref: typeof gt['ref'] === 'string' ? gt['ref'] : undefined,
        sha: parseSha(gt['sha'], `${loc}.git`),
      },
      ...(gitFilter !== undefined ? { filter: gitFilter } : {}),
      ...gitConds,
    };
  }

  if ('aws_s3' in obj) {
    if (typeof obj['aws_s3'] !== 'string' || !obj['aws_s3']) {
      throw new Error(`${loc}.aws_s3: must be a non-empty string (s3:// URI)`);
    }
    const result = { aws_s3: obj['aws_s3'] } as AwsS3Src;
    const s3Filter = parseFilter(obj, loc);
    if (s3Filter !== undefined) result.filter = s3Filter;
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
  extraKnownKeys: string[] = [],
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

  const knownKeys = new Set([
    'conflicts',
    'arrays',
    'objects',
    ...extraKnownKeys,
  ]);
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      throw new Error(`${loc}.${kind}.${key}: unknown option`);
    }
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
    ['replace', 'concat', 'dedupe'],
    ['replace', 'merge'],
    ['indent', 'trailing_commas', 'sort_keys', 'minify', 'strip_comments'],
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
    ['replace', 'concat', 'dedupe'],
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
    ['replace', 'concat', 'dedupe'],
    ['replace', 'merge'],
  );
}

function parseIniMergeOptions(raw: unknown, loc: string): IniMergeOptions {
  return parseMergeOptions<
    IniConflictStrategy,
    IniArrayStrategy,
    IniObjectStrategy
  >(
    raw,
    loc,
    'ini',
    ['abort', 'first_wins', 'last_wins'],
    ['replace', 'concat', 'dedupe'],
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
