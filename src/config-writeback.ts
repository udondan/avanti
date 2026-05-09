import * as fs from 'fs';
import { parseDocument, isSeq } from 'yaml';
import { atomicWrite } from './writer';

/** Writes updated SHA values into the config YAML file in-place, preserving comments. */
export function writeUpdatedShas(
  configPath: string,
  updates: Map<string, string>, // sourceLabel → new sha
): void {
  if (updates.size === 0) return;
  const raw = fs.readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);

  const filesNode = doc.get('files', true);
  if (!filesNode || typeof filesNode !== 'object' || !('items' in filesNode))
    return;

  const filesSeq = filesNode as { items: unknown[] };
  filesSeq.items.forEach((fileItem, fileIdx) => {
    if (!fileItem || typeof fileItem !== 'object') return;
    // YAML sequence items are the nodes themselves (YAMLMap) — no .value wrapper
    const entryNode = fileItem as {
      get?: (k: string, keepScalar?: boolean) => unknown;
    };
    if (!entryNode.get) return;

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
        ? ['files', fileIdx, 'src', srcIdx]
        : ['files', fileIdx, 'src'];

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
        doc.setIn(shaPath, updates.get(label)!);
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

  atomicWrite([{ targetPath: configPath, content: doc.toString() }]);
}
