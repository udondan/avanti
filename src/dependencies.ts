import * as os from 'os';
import * as path from 'path';
import { FileEntry, FileSrc, Variables } from './types';
import { resolveVars } from './variables';
import { isGitRemoteUrl } from './sources/git';

function resolveEntryTarget(
  entry: FileEntry,
  workingDir: string,
  vars: Variables,
): string | null {
  try {
    const target = resolveVars(entry.target, vars);
    if (target.startsWith('~/')) {
      return path.resolve(os.homedir(), target.slice(2));
    }
    if (path.isAbsolute(target)) return target;
    return path.resolve(workingDir, target);
  } catch {
    return null;
  }
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
      if (typeof s === 'string') {
        const resolved = resolveVars(s, vars);
        if (
          resolved.startsWith('http://') ||
          resolved.startsWith('https://') ||
          isGitRemoteUrl(resolved)
        ) {
          continue;
        }
        results.push(absoluteLocal(resolved, workingDir));
      } else if ('path' in s) {
        results.push(absoluteLocal(resolveVars(s.path, vars), workingDir));
      }
    } catch {
      // Unresolvable variable — skip edge
    }
  }
  return results;
}

function absoluteLocal(resolved: string, workingDir: string): string {
  if (resolved.startsWith('~/'))
    return path.resolve(os.homedir(), resolved.slice(2));
  if (path.isAbsolute(resolved)) return resolved;
  return path.resolve(workingDir, resolved);
}

export function sortByDependencies(
  entries: [string, FileEntry][],
  workingDir: string,
  vars: Variables,
): [string, FileEntry][] {
  // Map from resolved absolute target path → entry key
  const targetToKey = new Map<string, string>();
  for (const [key, entry] of entries) {
    const target = resolveEntryTarget(entry, workingDir, vars);
    if (target !== null) targetToKey.set(target, key);
  }

  // before[key] = set of keys that must be placed before key
  const before = new Map<string, Set<string>>();
  for (const [key] of entries) before.set(key, new Set());
  for (const [key, entry] of entries) {
    for (const localPath of localSourcePaths(entry.src, workingDir, vars)) {
      const dep = targetToKey.get(localPath);
      if (dep !== undefined && dep !== key) before.get(key)!.add(dep);
    }
  }

  // Kahn's algorithm — preserves original order within each wave
  const entryMap = new Map(entries);
  const remaining = new Set(entries.map(([k]) => k));
  const deg = new Map<string, number>(
    entries.map(([k]) => [k, before.get(k)!.size]),
  );
  const sorted: [string, FileEntry][] = [];

  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const [key] of entries) {
      if (remaining.has(key) && deg.get(key) === 0) wave.push(key);
    }
    if (wave.length === 0) {
      const cycle = findCycle(remaining, before);
      throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
    }
    for (const key of wave) {
      sorted.push([key, entryMap.get(key)!]);
      remaining.delete(key);
      for (const [k] of entries) {
        if (remaining.has(k) && before.get(k)!.has(key)) {
          deg.set(k, deg.get(k)! - 1);
        }
      }
    }
  }

  return sorted;
}

function findCycle(
  nodes: Set<string>,
  before: Map<string, Set<string>>,
): string[] {
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    if (stack.includes(node)) {
      const idx = stack.indexOf(node);
      return [...stack.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    stack.push(node);
    for (const dep of before.get(node) ?? []) {
      if (!nodes.has(dep)) continue;
      const cycle = dfs(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    return null;
  }

  for (const node of nodes) {
    const cycle = dfs(node);
    if (cycle !== null) return cycle;
  }
  return [...nodes];
}
