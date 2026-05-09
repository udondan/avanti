import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { isRemoteConfigSpec, loadConfig, resolveConfigPath } from '../config';
import { fetchSource } from '../sources';

export function lockCommand(): Command {
  return new Command('lock')
    .description(
      'Compute and pin SHA values for all remote sources in the config',
    )
    .option('--force', 'overwrite existing SHA values')
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { force?: boolean };
      const configPath = resolveConfigPath(
        cmd.parent?.opts().config as string | undefined,
      );
      const rawWorkingDir = cmd.parent?.opts().workingDir as string | undefined;
      const workingDir = rawWorkingDir
        ? path.resolve(rawWorkingDir)
        : process.cwd();

      if (isRemoteConfigSpec(configPath)) {
        console.error('avanti lock requires a local config file.');
        process.exit(2);
      }

      let config;
      try {
        config = await loadConfig(configPath);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(2);
      }

      const vars = config.variables ?? {};
      const toPin: Array<{ label: string; sha: string }> = [];
      let hasError = false;

      for (const entry of config.files) {
        try {
          const result = await fetchSource(entry, workingDir, vars);
          for (const rec of result.sourceRecords) {
            if (!opts.force && rec.expectedSha !== undefined) continue;
            toPin.push({ label: rec.sourceLabel, sha: rec.observedSha });
          }
        } catch (err: unknown) {
          console.error(
            `Error processing ${JSON.stringify(entry.src)}: ${(err as Error).message}`,
          );
          hasError = true;
        }
      }

      if (toPin.length === 0) {
        console.log(
          opts.force
            ? 'No remote sources found.'
            : 'All remote sources already have SHA values pinned. Use --force to overwrite.',
        );
        process.exit(hasError ? 2 : 0);
      }

      // Write SHAs into config preserving comments
      const raw = fs.readFileSync(configPath, 'utf8');
      const doc = parseDocument(raw);
      const pinByLabel = new Map(toPin.map((p) => [p.label, p.sha]));

      const filesNode = doc.get('files', true);
      if (filesNode && typeof filesNode === 'object' && 'items' in filesNode) {
        const filesSeq = filesNode as { items: unknown[] };
        filesSeq.items.forEach((fileItem, fileIdx) => {
          if (
            !fileItem ||
            typeof fileItem !== 'object' ||
            !('value' in fileItem)
          )
            return;
          const rawValue = (fileItem as Record<string, unknown>).value;
          const entryNode = rawValue as {
            get?: (k: string, keepScalar?: boolean) => unknown;
          };
          if (!entryNode?.get) return;
          const srcNode = entryNode.get('src', true);
          if (!srcNode) return;

          const processSrcItem = (item: unknown, srcIdx: number): void => {
            if (!item || typeof item !== 'object') return;
            const n = item as {
              get?: (k: string, keepScalar?: boolean) => unknown;
            };
            if (!n.get) return;

            let label: string | null = null;
            let shaPath: (string | number)[] | null = null;

            if (n.get('github')) {
              const gh = n.get('github') as {
                get?: (k: string) => unknown;
              } | null;
              if (gh?.get) {
                const repo = gh.get('repo') as string | null;
                const file = gh.get('file') as string | null;
                if (repo && file) {
                  label = `github:${repo}:${file}`;
                  shaPath = ['files', fileIdx, 'src', srcIdx, 'github', 'sha'];
                }
              }
            } else if (n.get('gitlab')) {
              const gl = n.get('gitlab') as {
                get?: (k: string) => unknown;
              } | null;
              if (gl?.get) {
                const project = gl.get('project') as string | null;
                const file = gl.get('file') as string | null;
                if (project && file) {
                  label = `gitlab:${project}:${file}`;
                  shaPath = ['files', fileIdx, 'src', srcIdx, 'gitlab', 'sha'];
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
                if (ws && repo && file) {
                  label = `bitbucket:${ws}/${repo}:${file}`;
                  shaPath = [
                    'files',
                    fileIdx,
                    'src',
                    srcIdx,
                    'bitbucket',
                    'sha',
                  ];
                }
              }
            } else if (n.get('git')) {
              const gt = n.get('git') as {
                get?: (k: string) => unknown;
              } | null;
              if (gt?.get) {
                const repo = gt.get('repo') as string | null;
                const file = gt.get('file') as string | null;
                if (repo && file) {
                  label = `git:${repo}:${file}`;
                  shaPath = ['files', fileIdx, 'src', srcIdx, 'git', 'sha'];
                }
              }
            } else if (n.get('exec') !== undefined) {
              const cmd2 = n.get('exec') as string | null;
              if (cmd2) {
                label = `exec:${cmd2}`;
                shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
              }
            } else if (n.get('s3') !== undefined) {
              const s3 = n.get('s3') as string | null;
              if (s3) {
                label = `s3:${s3}`;
                shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
              }
            } else if (n.get('vault')) {
              const vt = n.get('vault') as {
                get?: (k: string) => unknown;
              } | null;
              if (vt?.get) {
                const p = vt.get('path') as string | null;
                if (p) {
                  label = `vault:${p}`;
                  shaPath = ['files', fileIdx, 'src', srcIdx, 'vault', 'sha'];
                }
              }
            } else if (n.get('http') !== undefined) {
              const url = n.get('http') as string | null;
              if (url) {
                label = `http:${url}`;
                shaPath = ['files', fileIdx, 'src', srcIdx, 'sha'];
              }
            }

            if (label && shaPath && pinByLabel.has(label)) {
              doc.setIn(shaPath, pinByLabel.get(label)!);
            }
          };

          if (srcNode && typeof srcNode === 'object' && 'items' in srcNode) {
            const srcSeq = srcNode as { items: unknown[] };
            srcSeq.items.forEach((item, idx) => {
              if (item && typeof item === 'object' && 'value' in item) {
                processSrcItem((item as Record<string, unknown>).value, idx);
              } else {
                processSrcItem(item, idx);
              }
            });
          } else {
            processSrcItem(srcNode, 0);
          }
        });
      }

      fs.writeFileSync(configPath, doc.toString(), 'utf8');

      for (const p of toPin) {
        console.log(`  pinned  ${p.label}  ${p.sha.slice(0, 16)}`);
      }
      console.log(`\nPinned ${toPin.length} source(s).`);

      process.exit(hasError ? 2 : 0);
    });
}
