import { EnvironmentSpec, VariableSpec, Variables } from './types';
import { TOKEN } from './variables';
import { resolveVariableEntry } from './variables-remote';
import { resolveEnvironmentEntry } from './environment';
import { FetchCache } from './sources';
import { FetchContext } from './variables/source-text';
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
interface RefIndex {
  nodeKeyByName: Map<string, string>;
  envNodeKeyByName: Map<string, string>;
}

const LEADING_NAME = /^[A-Za-z_]\w*/;

function referencedNodeKey(
  m: RegExpExecArray | RegExpMatchArray,
  index: RefIndex,
): string | undefined {
  const [match, envName, bracedExpr, varName] = m;
  if (match === '$$') return undefined;
  if (envName !== undefined) return index.envNodeKeyByName.get(envName);
  const name =
    bracedExpr !== undefined
      ? LEADING_NAME.exec(bracedExpr.trim())?.[0]
      : varName;
  return name !== undefined ? index.nodeKeyByName.get(name) : undefined;
}

function collectReferences(
  value: unknown,
  index: RefIndex,
  deps: Set<string>,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) {
      const key = referencedNodeKey(m, index);
      if (key !== undefined) deps.add(key);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  const children: unknown[] = Array.isArray(value)
    ? value
    : Object.values(value);
  for (const child of children) {
    collectReferences(child, index, deps, seen);
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

  const index: RefIndex = { nodeKeyByName, envNodeKeyByName };
  const makeNode = (kind: NodeKind, name: string, value: unknown): Node => {
    const deps = new Set<string>();
    collectReferences(dependencySurface(value), index, deps);
    return { kind, name, key: `${kind}:${name}`, value, deps };
  };
  const nodes: Node[] = [];
  for (const [name, value] of Object.entries(variables)) {
    nodes.push(makeNode('var', name, value));
  }
  for (const [name, value] of Object.entries(environment)) {
    nodes.push(makeNode('env', name, value));
  }
  return nodes;
}

// Find and report one actual cycle chain among the still-unresolved nodes, for
// a clear error message once the peel loop stalls. Every stuck node has at
// least one dependency that is itself stuck (otherwise it would have been
// eligible), so following the first stuck dependency from any stuck node must
// eventually revisit a node on the current chain.
function findCycle(stuck: Node[]): string[] {
  const byKey = new Map(stuck.map((n) => [n.key, n]));

  function label(n: Node): string {
    return n.kind === 'var' ? `variables.${n.name}` : `environment.${n.name}`;
  }

  const chain: string[] = [];
  let key = stuck[0].key;
  while (!chain.includes(key)) {
    chain.push(key);
    // Dependencies outside the stuck set are already resolved — skip them.
    key = [...byKey.get(key)!.deps].find((dep) => byKey.has(dep))!;
  }
  return [...chain.slice(chain.indexOf(key)), key].map((k) =>
    label(byKey.get(k)!),
  );
}

// Keys previously written to process.env by this function, tracked so a
// re-invocation (the $self stabilization loop) can clear stale values before
// resolving again — a config that drops/renames an environment: entry
// between iterations must not leak its old value forward.
let previouslyInjectedEnvKeys = new Set<string>();

interface ResolveState {
  resolved: Variables;
  env: Record<string, string>;
  workingDir: string;
  ctx: FetchContext;
}

async function resolveNode(node: Node, state: ResolveState): Promise<void> {
  const { resolved, workingDir, ctx } = state;
  if (node.kind === 'var') {
    resolved[node.name] = await resolveVariableEntry(
      node.name,
      node.value as VariableSpec[string],
      resolved,
      workingDir,
      ctx,
    );
    return;
  }
  const value = await resolveEnvironmentEntry(
    node.name,
    node.value as EnvironmentSpec[string],
    resolved,
    workingDir,
    ctx,
  );
  resolved[node.name] = value;
  state.env[node.name] = value;
  process.env[node.name] = value;
  previouslyInjectedEnvKeys.add(node.name);
}

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

  const state: ResolveState = {
    resolved: Object.create(null) as Variables,
    env: Object.create(null) as Record<string, string>,
    workingDir,
    ctx: { cache, configBase },
  };
  const done = new Set<string>();
  let remaining = buildNodes(variables, environment);

  while (remaining.length > 0) {
    const eligible = remaining.filter((n) =>
      [...n.deps].every((d) => done.has(d)),
    );
    if (eligible.length === 0) {
      const cycle = findCycle(remaining);
      throw new Error(`Circular dependency: ${cycle.join(' → ')}`);
    }
    for (const node of eligible) {
      await resolveNode(node, state);
      done.add(node.key);
    }
    const eligibleKeys = new Set(eligible.map((n) => n.key));
    remaining = remaining.filter((n) => !eligibleKeys.has(n.key));
  }

  const envKeys = Object.keys(state.env);
  if (envKeys.length > 0) {
    verbose(`environment: resolved ${envKeys.join(', ')}`);
  }

  return { vars: state.resolved, env: state.env };
}
