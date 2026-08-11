import { EnvironmentSpec, VariableSpec, Variables } from './types';
import { TOKEN } from './variables';
import { resolveVariableEntry } from './variables-remote';
import { resolveEnvironmentEntry } from './environment';
import { FetchCache } from './sources';
import { verbose } from './logger';

type NodeKind = 'var' | 'env';

interface Node {
  kind: NodeKind;
  name: string;
  key: string; // `var:NAME` or `env:NAME` — unique across the combined graph
  value: unknown;
  deps: Set<string>; // keys of other nodes this node references
}

// Statically scan a raw (unresolved) value for $name / ${expr} / $env:NAME
// token references, without resolving or fetching anything, and add the
// corresponding node key (`var:NAME` or `env:NAME`) to `deps` for every
// reference that resolves to a declared node. `nodeKeyByName` maps every
// declared variables:/environment: name to its node key (disjoint by
// construction — each name maps to exactly one), used for $name/${expr}
// references. `envNodeKeyByName` maps only environment: names to their node
// key, used for $env:NAME references, since $env: can only ever reach a
// value that was actually written to process.env.
// Everything else (ambient env vars, reserved sentinels like $latest,
// undeclared names) is left for normal resolution-time handling.
// `seen` guards against genuine circular JS object/array references in a raw
// value (e.g. `obj.self = obj`) — the scan phase must not throw or infinite-
// loop on these; that validation is deepResolveVars's job at actual
// resolution time, so a re-visited object is silently skipped here.
function collectReferences(
  value: unknown,
  nodeKeyByName: Map<string, string>,
  envNodeKeyByName: Map<string, string>,
  deps: Set<string>,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) {
      const [match, envName, bracedExpr, varName] = m;
      if (match === '$$') continue;
      if (envName !== undefined) {
        const key = envNodeKeyByName.get(envName);
        if (key !== undefined) deps.add(key);
        continue;
      }
      const name =
        bracedExpr !== undefined
          ? bracedExpr.trim().match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
          : varName;
      const key = name !== undefined ? nodeKeyByName.get(name) : undefined;
      if (key !== undefined) deps.add(key);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) {
      collectReferences(item, nodeKeyByName, envNodeKeyByName, deps, seen);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const v of Object.values(value)) {
      collectReferences(v, nodeKeyByName, envNodeKeyByName, deps, seen);
    }
  }
}

// The "raw dependency surface" of a node's value — the part that is
// statically scanned for $name/$env:NAME references. For source-backed
// entries this is only the `src` field (matching what is actually
// variable-substituted at resolution time); for plain values it's the value
// itself.
function dependencySurface(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'src')
  ) {
    return (value as { src: unknown }).src;
  }
  return value;
}

function buildNodes(
  variables: VariableSpec,
  environment: EnvironmentSpec,
): Node[] {
  const nodeKeyByName = new Map<string, string>();
  for (const name of Object.keys(variables))
    nodeKeyByName.set(name, `var:${name}`);
  for (const name of Object.keys(environment))
    nodeKeyByName.set(name, `env:${name}`);
  const envNodeKeyByName = new Map<string, string>();
  for (const name of Object.keys(environment))
    envNodeKeyByName.set(name, `env:${name}`);

  const nodes: Node[] = [];
  for (const [name, value] of Object.entries(variables)) {
    const deps = new Set<string>();
    collectReferences(
      dependencySurface(value),
      nodeKeyByName,
      envNodeKeyByName,
      deps,
    );
    nodes.push({ kind: 'var', name, key: `var:${name}`, value, deps });
  }
  for (const [name, value] of Object.entries(environment)) {
    const deps = new Set<string>();
    collectReferences(
      dependencySurface(value),
      nodeKeyByName,
      envNodeKeyByName,
      deps,
    );
    nodes.push({ kind: 'env', name, key: `env:${name}`, value, deps });
  }
  return nodes;
}

// DFS over the still-unresolved nodes to find and report one actual cycle
// chain, for a clear error message once the peel loop stalls.
function findCycle(stuck: Node[]): string[] {
  const byKey = new Map(stuck.map((n) => [n.key, n]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function label(n: Node): string {
    return n.kind === 'var' ? `variables.${n.name}` : `environment.${n.name}`;
  }

  function visit(key: string): string[] | null {
    const node = byKey.get(key);
    if (!node) return null; // dependency outside the stuck set — not part of the cycle
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const dep of node.deps) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  }

  for (const n of stuck) {
    const cycle = visit(n.key);
    if (cycle) return cycle.map((k) => label(byKey.get(k)!));
  }
  // Should be unreachable — a stalled peel loop always contains a cycle.
  return stuck.map(label);
}

// Keys previously written to process.env by this function, tracked so a
// re-invocation (the $self stabilization loop) can clear stale values before
// resolving again — a config that drops/renames an environment: entry
// between iterations must not leak its old value forward.
let previouslyInjectedEnvKeys = new Set<string>();

export async function resolveVariablesAndEnvironment(
  variables: VariableSpec,
  environment: EnvironmentSpec,
  workingDir: string,
  cache?: FetchCache,
  configBase?: string,
): Promise<{ vars: Variables; env: Record<string, string> }> {
  for (const key of previouslyInjectedEnvKeys) {
    delete process.env[key];
  }
  previouslyInjectedEnvKeys = new Set<string>();

  const nodes = buildNodes(variables, environment);
  const resolved: Variables = Object.create(null) as Variables;
  const env: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const done = new Set<string>();
  let remaining = nodes;

  while (remaining.length > 0) {
    const eligible = remaining.filter((n) =>
      [...n.deps].every((d) => done.has(d)),
    );
    if (eligible.length === 0) {
      const cycle = findCycle(remaining);
      throw new Error(`Circular dependency: ${cycle.join(' → ')}`);
    }
    for (const node of eligible) {
      if (node.kind === 'var') {
        resolved[node.name] = await resolveVariableEntry(
          node.name,
          node.value as VariableSpec[string],
          resolved,
          workingDir,
          cache,
          configBase,
        );
      } else {
        const value = await resolveEnvironmentEntry(
          node.name,
          node.value as EnvironmentSpec[string],
          resolved,
          workingDir,
          cache,
          configBase,
        );
        resolved[node.name] = value;
        env[node.name] = value;
        process.env[node.name] = value;
        previouslyInjectedEnvKeys.add(node.name);
      }
      done.add(node.key);
    }
    const eligibleKeys = new Set(eligible.map((n) => n.key));
    remaining = remaining.filter((n) => !eligibleKeys.has(n.key));
  }

  if (Object.keys(env).length > 0) {
    verbose(`environment: resolved ${Object.keys(env).join(', ')}`);
  }

  return { vars: resolved, env };
}
