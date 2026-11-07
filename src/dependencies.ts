import * as os from 'os';
import * as path from 'path';
import { FileEntry, FileSrc, Variables } from './types';
import { resolveVars } from './variables';
import { isGitRemoteUrl } from './sources/git';

type Entry = [string, FileEntry];

function absoluteLocal(resolved: string, workingDir: string): string {
  if (resolved.startsWith('~/'))
    return path.resolve(os.homedir(), resolved.slice(2));
  if (path.isAbsolute(resolved)) return path.resolve(resolved);
  return path.resolve(workingDir, resolved);
}

function resolveEntryTarget(
  entry: FileEntry,
  workingDir: string,
  vars: Variables,
): string | null {
  try {
    return absoluteLocal(resolveVars(entry.target, vars), workingDir);
  } catch {
    return null;
  }
}

function isRemoteString(resolved: string): boolean {
  return (
    resolved.startsWith('http://') ||
    resolved.startsWith('https://') ||
    isGitRemoteUrl(resolved)
  );
}

/** The unresolved local path a src refers to, or null for non-local sources. */
function localSrcString(s: FileSrc, vars: Variables): string | null {
  if (typeof s === 'string') {
    const resolved = resolveVars(s, vars);
    return isRemoteString(resolved) ? null : resolved;
  }
  return 'path' in s ? resolveVars(s.path, vars) : null;
}

function localSourcePaths(
  src: FileSrc | FileSrc[],
  workingDir: string,
  vars: Variables,
): string[] {
  const srcs = Array.isArray(src) ? src : [src];
  const results: string[] = [];
  for (const s of srcs) {
    try {
      const local = localSrcString(s, vars);
      if (local !== null) results.push(absoluteLocal(local, workingDir));
    } catch {
      // Unresolvable variable — skip edge
    }
  }
  return results;
}

/** before[key] = set of keys that must be placed before key. */
function buildBeforeMap(
  entries: Entry[],
  workingDir: string,
  vars: Variables,
): Map<string, Set<string>> {
  // Map from resolved absolute target path → entry key
  const targetToKey = new Map<string, string>();
  for (const [key, entry] of entries) {
    const target = resolveEntryTarget(entry, workingDir, vars);
    if (target !== null) targetToKey.set(target, key);
  }

  const before = new Map<string, Set<string>>();
  for (const [key] of entries) before.set(key, new Set());
  for (const [key, entry] of entries) {
    for (const localPath of localSourcePaths(entry.src, workingDir, vars)) {
      const dep = targetToKey.get(localPath);
      if (dep !== undefined && dep !== key) before.get(key)!.add(dep);
    }
  }
  return before;
}

interface SortState {
  entries: Entry[];
  before: Map<string, Set<string>>;
  remaining: Set<string>;
  deg: Map<string, number>;
}

function nextWave(state: SortState): string[] {
  const wave: string[] = [];
  for (const [key] of state.entries) {
    if (state.remaining.has(key) && state.deg.get(key) === 0) wave.push(key);
  }
  if (wave.length === 0) {
    const cycle = findCycle(state.remaining, state.before);
    throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
  }
  return wave;
}

function place(state: SortState, key: string): void {
  state.remaining.delete(key);
  for (const [k] of state.entries) {
    if (state.remaining.has(k) && state.before.get(k)!.has(key)) {
      state.deg.set(k, state.deg.get(k)! - 1);
    }
  }
}

export function sortByDependencies(
  entries: Entry[],
  workingDir: string,
  vars: Variables,
): Entry[] {
  const before = buildBeforeMap(entries, workingDir, vars);

  // Kahn's algorithm — preserves original order within each wave
  const entryMap = new Map(entries);
  const state: SortState = {
    entries,
    before,
    remaining: new Set(entries.map(([k]) => k)),
    deg: new Map(entries.map(([k]) => [k, before.get(k)!.size])),
  };
  const sorted: Entry[] = [];

  while (state.remaining.size > 0) {
    for (const key of nextWave(state)) {
      sorted.push([key, entryMap.get(key)!]);
      place(state, key);
    }
  }

  return sorted;
}

function findCycle(
  nodes: Set<string>,
  before: Map<string, Set<string>>,
): string[] {
  // Every remaining node still has at least one unplaced dependency (its
  // in-degree is non-zero), so following the first remaining dependency from
  // any remaining node must eventually revisit a node on the current chain.
  const chain: string[] = [];
  let node = nodes.values().next().value!;
  while (!chain.includes(node)) {
    chain.push(node);
    node = [...before.get(node)!].find((dep) => nodes.has(dep))!;
  }
  return [...chain.slice(chain.indexOf(node)), node];
}
