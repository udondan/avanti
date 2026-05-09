import * as fs from 'fs';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';
import { atomicWrite } from './writer';

/**
 * Applies updated SHA values into a parsed YAML config string in-place,
 * preserving comments. Returns the new content, or null if no updates matched.
 */
export function applyUpdatedShas(
  raw: string,
  updates: Map<string, string>, // sourceLabel → new sha
): string | null {
  if (updates.size === 0) return null;
  const doc = parseDocument(raw);

  const filesNode = doc.get('files', true);
  if (!isMap(filesNode)) return null;

  let changed = false;

  filesNode.items.forEach((pair) => {
    if (!pair || typeof pair !== 'object') return;
    const p = pair as { key?: unknown; value?: unknown };
    const targetKey =
      p.key != null && isScalar(p.key) ? String(p.key.value) : null;
    if (!targetKey) return;

    const entryNode = p.value as {
      get?: (k: string, keepScalar?: boolean) => unknown;
    } | null;
    if (!entryNode?.get) return;

    const srcNode = entryNode.get('src', true);
    if (!srcNode) return;

    // inSeq=true → src is a sequence; shaPath includes the numeric srcIdx.
    // inSeq=false → src is a single map; omit the index so the path matches.
    const processSrcItem = (
      item: unknown,
      srcIdx: number,
      inSeq: boolean,
    ): void => {
      if (!item || typeof item !== 'object') return;
      const n = item as { get?: (k: string, keepScalar?: boolean) => unknown };
      if (!n.get) return;

      const srcBase: (string | number)[] = inSeq
        ? ['files', targetKey, 'src', srcIdx]
        : ['files', targetKey, 'src'];

      let label: string | null = null;
      let shaPath: (string | number)[] | null = null;

      if (n.get('github')) {
        const gh = n.get('github') as {
          get?: (k: string) => unknown;
        } | null;
        if (gh?.get) {
          const repo = gh.get('repo') as string | null;
          const file = gh.get('file') as string | null;
          const ref = gh.get('ref') as string | null;
          if (repo && file) {
            label = `github:${repo}:${file}${ref ? `@${ref}` : ''}`;
            shaPath = [...srcBase, 'github', 'sha'];
          }
        }
      } else if (n.get('gitlab')) {
        const gl = n.get('gitlab') as { get?: (k: string) => unknown } | null;
        if (gl?.get) {
          const project = gl.get('project') as string | null;
          const file = gl.get('file') as string | null;
          const ref = gl.get('ref') as string | null;
          if (project && file) {
            label = `gitlab:${project}:${file}${ref ? `@${ref}` : ''}`;
            shaPath = [...srcBase, 'gitlab', 'sha'];
          }
        }
      } else if (n.get('bitbucket')) {
        const bb = n.get('bitbucket') as {
          get?: (k: string) => unknown;
        } | null;
        if (bb?.get) {
          const ws = bb.get('workspace') as string | null;
          const repo = bb.get('repo') as string | null;
          const file = bb.get('file') as string | null;
          const ref = bb.get('ref') as string | null;
          if (ws && repo && file) {
            label = `bitbucket:${ws}/${repo}:${file}${ref ? `@${ref}` : ''}`;
            shaPath = [...srcBase, 'bitbucket', 'sha'];
          }
        }
      } else if (n.get('git')) {
        const gt = n.get('git') as { get?: (k: string) => unknown } | null;
        if (gt?.get) {
          const repo = gt.get('repo') as string | null;
          const file = gt.get('file') as string | null;
          const ref = gt.get('ref') as string | null;
          if (repo && file) {
            label = `git:${repo}:${file}${ref ? `@${ref}` : ''}`;
            shaPath = [...srcBase, 'git', 'sha'];
          }
        }
      } else if (n.get('exec') !== undefined) {
        const cmd = n.get('exec') as string | null;
        if (cmd) {
          label = `exec:${cmd}`;
          shaPath = [...srcBase, 'sha'];
        }
      } else if (n.get('s3') !== undefined) {
        const s3 = n.get('s3') as string | null;
        if (s3) {
          label = `s3:${s3}`;
          shaPath = [...srcBase, 'sha'];
        }
      } else if (n.get('vault')) {
        const vt = n.get('vault') as { get?: (k: string) => unknown } | null;
        if (vt?.get) {
          const p = vt.get('path') as string | null;
          const field = vt.get('field') as string | null;
          if (p) {
            label = `vault:${p}${field ? `#${field}` : ''}`;
            shaPath = [...srcBase, 'vault', 'sha'];
          }
        }
      } else if (n.get('http') !== undefined) {
        const url = n.get('http') as string | null;
        if (url) {
          label = `http:${url}`;
          shaPath = [...srcBase, 'sha'];
        }
      }

      if (label && shaPath && updates.has(label)) {
        const newSha = updates.get(label)!;
        if ((doc.getIn(shaPath) as string | undefined) !== newSha) {
          doc.setIn(shaPath, newSha);
          changed = true;
        }
      }
    };

    if (isSeq(srcNode)) {
      srcNode.items.forEach((item, idx) => {
        processSrcItem(item, idx, true);
      });
    } else {
      processSrcItem(srcNode, 0, false);
    }
  });

  return changed ? doc.toString() : null;
}

/**
 * Writes updated SHA values into the config YAML file in-place, preserving comments.
 * Returns true if the file was actually modified, false if no labels matched or all
 * values were already up to date.
 */
export function writeUpdatedShas(
  configPath: string,
  updates: Map<string, string>, // sourceLabel → new sha
): boolean {
  if (updates.size === 0) return false;
  const raw = fs.readFileSync(configPath, 'utf8');
  const newContent = applyUpdatedShas(raw, updates);
  if (newContent !== null) {
    atomicWrite([{ targetPath: configPath, content: newContent }]);
    return true;
  }
  return false;
}
