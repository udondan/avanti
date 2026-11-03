// diff: the less common arms of `avanti diff` — values thrown that are not
// Error instances, defaults and remote configs (in-process, selected modules
// spied on).
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffCommand } from '../src/commands/diff';
import * as condition from '../src/condition';
import * as config from '../src/config';
import * as context from '../src/context';
import * as dependencies from '../src/dependencies';
import * as sources from '../src/sources';
import {
  makeTempEnv,
  runCommand,
  TempEnv,
  throwNonError,
} from './commands-pull-helpers';

let env: TempEnv;

function diff(configArg = env.configPath) {
  return runCommand(diffCommand(), [
    '--config',
    configArg,
    '--working-dir',
    env.work,
    'diff',
  ]);
}

const RAW_ENTRY = `files:
  out.txt:
    src:
      - raw: x
`;

const SELF_ENTRY = `files:
  $self:
    src:
      - raw: "files: {}"
`;

beforeEach(() => {
  env = makeTempEnv('diff-branches');
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

describe('diff: values thrown that are not errors', () => {
  it('reports a config load failure', async () => {
    vi.spyOn(config, 'loadConfig').mockRejectedValue('no config');
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no config');
  });

  it('reports a variable resolution failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(context, 'resolveVariablesAndEnvironment').mockRejectedValue(
      'no vars',
    );
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no vars');
  });

  it('reports a $self condition failure', async () => {
    env.writeConfig(SELF_ENTRY);
    vi.spyOn(condition, 'evaluateConditions').mockImplementation(() => {
      throwNonError('bad condition');
    });
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('Error processing $self: bad condition');
  });

  it('reports a dependency sort failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(dependencies, 'sortByDependencies').mockImplementation(() => {
      throwNonError('no order');
    });
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('no order');
  });

  it('reports a fetch failure', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(sources, 'fetchSource').mockRejectedValue('offline');
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('Error processing [{"raw":"x"}]: offline');
  });

  it('reports an invalid merged $self config', async () => {
    env.writeConfig(SELF_ENTRY);
    vi.spyOn(config, 'parseConfigContent').mockImplementation(() => {
      throwNonError('unparsable');
    });
    const res = await diff();
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('$self config is invalid: unparsable');
  });
});

describe('diff: defaults', () => {
  it('uses the current directory without --working-dir', async () => {
    env.writeConfig(RAW_ENTRY);
    vi.spyOn(process, 'cwd').mockReturnValue(env.work);
    const res = await runCommand(diffCommand(), [
      '--config',
      env.configPath,
      'diff',
    ]);
    expect(res.code).toBe(1);
  });

  it('handles a config without variables and environment', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      files: config.parseConfigContent(RAW_ENTRY).files,
    });
    const res = await diff();
    expect(res.code).toBe(1);
  });
});

describe('diff: templates', () => {
  it('renders each file of a directory source', async () => {
    const dir = path.join(env.work, 'tpl');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hi {{ name }}');
    env.writeConfig(`variables:
  name: world
files:
  out/:
    src: ${JSON.stringify(dir + path.sep)}
    template: handlebars
`);
    const res = await diff();
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('hi world');
  });
});

describe('diff: remote config', () => {
  let server: http.Server;
  let url: string;
  let body = '';

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/avanti.yml`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not diff a remote config against its $self content', async () => {
    const src = path.join(env.work, 'src.txt');
    fs.writeFileSync(src, 'content');
    body = `files:
  $self:
    src:
      - raw: |
          files:
            out.txt:
              src: ${JSON.stringify(src)}
`;
    const res = await diff(url);
    expect(res.code).toBe(1);
    expect(res.stderr).toBe('');
    expect(fs.existsSync(path.join(env.work, 'out.txt'))).toBe(false);
  });

  it('reports no changes when the remote $self only merges itself', async () => {
    body = SELF_ENTRY;
    const res = await diff(url);
    expect(res.code).toBe(0);
  });
});
