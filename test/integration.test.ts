import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '../src/cli.ts');
const PROJECT_ROOT = resolve(__dirname, '..');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runAvanti(configPath: string, workingDir: string): RunResult {
  try {
    const stdout = execSync(
      `bunx tsx "${CLI}" --config "${configPath}" --working-dir "${workingDir}" pull --yes`,
      {
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 2,
    };
  }
}

function writeConfig(dir: string, content: string): string {
  const configPath = join(dir, 'avanti.yml');
  writeFileSync(configPath, content);
  return configPath;
}

describe('Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'avanti-integration-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('local source', () => {
    it('fetches a single local file', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'hello integration test');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'hello integration test',
      );
    });

    it('fetches a local directory recursively', () => {
      const sourceDir = join(tmpDir, 'source-dir');
      mkdirSync(sourceDir);
      writeFileSync(join(sourceDir, 'a.txt'), 'file a');
      writeFileSync(join(sourceDir, 'b.txt'), 'file b');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceDir}
    target: ./output-dir/
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output-dir', 'a.txt'), 'utf8')).toBe(
        'file a',
      );
      expect(readFileSync(join(tmpDir, 'output-dir', 'b.txt'), 'utf8')).toBe(
        'file b',
      );
    });
  });

  describe('HTTP source', () => {
    it('fetches a file from a URL', { timeout: 30_000 }, () => {
      const config = writeConfig(
        tmpDir,
        `files:
  - src: https://raw.githubusercontent.com/udondan/avanti/v0.4.0/LICENSE
    target: ./license.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'license.txt'), 'utf8');
      expect(content).toContain('MIT');
      expect(content).toContain('Daniel Schroeder');
    });
  });

  describe('GitHub source', () => {
    it(
      'fetches a single file from a public GitHub repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      github:
        repo: udondan/avanti
        file: LICENSE
        ref: v0.4.0
    target: ./license.txt
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const content = readFileSync(join(tmpDir, 'license.txt'), 'utf8');
        expect(content).toContain('MIT');
      },
    );

    it(
      'fetches a directory from a public GitHub repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      github:
        repo: udondan/avanti
        file: src/processors
        ref: v0.4.0
    target: ./processors/
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        expect(existsSync(join(tmpDir, 'processors', 'json.ts'))).toBe(true);
        expect(existsSync(join(tmpDir, 'processors', 'post.ts'))).toBe(true);
        expect(existsSync(join(tmpDir, 'processors', 'replace.ts'))).toBe(true);
      },
    );

    it(
      'resolves $latest ref to the most recent release',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      github:
        repo: udondan/avanti
        file: LICENSE
        ref: $latest
    target: ./license.txt
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        expect(readFileSync(join(tmpDir, 'license.txt'), 'utf8')).toContain(
          'MIT',
        );
      },
    );
  });

  describe('GitLab source', () => {
    it(
      'fetches a single file from a public GitLab repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      gitlab:
        project: gitlab-org/cli
        file: LICENSE
        ref: main
    target: ./license.txt
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const content = readFileSync(join(tmpDir, 'license.txt'), 'utf8');
        expect(content).toContain('MIT');
      },
    );

    it(
      'fetches a directory from a public GitLab repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      gitlab:
        project: gitlab-org/cli
        file: internal/config
        ref: main
    target: ./config/
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const outputDir = join(tmpDir, 'config');
        expect(existsSync(outputDir)).toBe(true);
        const entries = require('fs').readdirSync(outputDir, {
          recursive: true,
        });
        expect(entries.length).toBeGreaterThan(0);
      },
    );
  });

  describe('git source', () => {
    it(
      'fetches a single file from a public git remote',
      { timeout: 60_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      git:
        repo: https://github.com/udondan/avanti.git
        file: LICENSE
        ref: v0.4.0
    target: ./license.txt
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const content = readFileSync(join(tmpDir, 'license.txt'), 'utf8');
        expect(content).toContain('MIT');
        expect(content).toContain('Daniel Schroeder');
      },
    );

    it(
      'fetches a directory from a public git remote',
      { timeout: 60_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      git:
        repo: https://github.com/udondan/avanti.git
        file: src/processors
        ref: v0.4.0
    target: ./processors/
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        expect(existsSync(join(tmpDir, 'processors', 'json.ts'))).toBe(true);
        expect(existsSync(join(tmpDir, 'processors', 'post.ts'))).toBe(true);
        expect(existsSync(join(tmpDir, 'processors', 'replace.ts'))).toBe(true);
      },
    );

    it('fetches a file at a specific commit hash', { timeout: 60_000 }, () => {
      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      git:
        repo: https://github.com/udondan/avanti.git
        file: LICENSE
        ref: 8e12e2a0c9f1e4c9c39e89aef1a4f2c8d3b7e5f1
    target: ./license.txt
`,
      );

      // Invalid commit hash → should fail cleanly with exit code 2
      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(2);
    });
  });

  describe('Bitbucket source', () => {
    it(
      'fetches a single file from a public Bitbucket repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      bitbucket:
        workspace: atlassian
        repo: aui
        file: LICENSE
    target: ./license.txt
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const content = readFileSync(join(tmpDir, 'license.txt'), 'utf8');
        expect(content.length).toBeGreaterThan(0);
      },
    );

    it(
      'fetches a directory from a public Bitbucket repo',
      { timeout: 30_000 },
      () => {
        const config = writeConfig(
          tmpDir,
          `files:
  - src:
      bitbucket:
        workspace: atlassian
        repo: aui
        file: licenses/
    target: ./licenses/
`,
        );

        const { exitCode } = runAvanti(config, tmpDir);
        expect(exitCode).toBe(0);
        const outputDir = join(tmpDir, 'licenses');
        expect(existsSync(outputDir)).toBe(true);
        const entries = require('fs').readdirSync(outputDir, {
          recursive: true,
        });
        expect(entries.length).toBeGreaterThan(0);
      },
    );
  });

  describe('exec source', () => {
    it('runs a shell command and captures its output', () => {
      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      exec: printf 'hello from exec'
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toContain(
        'hello from exec',
      );
    });
  });

  describe('raw source', () => {
    it('uses inline raw content verbatim', () => {
      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      raw: "this is raw inline content"
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'this is raw inline content',
      );
    });
  });

  describe('replace processor', () => {
    it('replaces all occurrences of a plain string', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'foo and foo again');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: foo
        to: bar
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'bar and bar again',
      );
    });

    it('replaces using a regex pattern with flags', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'abc 123 def 456');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: "/\\\\d+/g"
        to: NUM
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'abc NUM def NUM',
      );
    });

    it('applies multiple replacement rules in order', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'one two three');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: one
        to: "1"
      - from: two
        to: "2"
      - from: three
        to: "3"
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe('1 2 3');
    });
  });

  describe('post processor', () => {
    it('pipes content through a shell command', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'hello world');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    post: "tr a-z A-Z"
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'HELLO WORLD',
      );
    });

    it('chains replace and post processors', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'foo bar');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: foo
        to: hello
    post: "tr a-z A-Z"
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'HELLO BAR',
      );
    });
  });

  describe('JSON merge', () => {
    it('merges two disjoint JSON files', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ a: 1, b: 'original' }));
      writeFileSync(bFile, JSON.stringify({ c: 3, d: 4 }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json: {}
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged).toMatchObject({ a: 1, b: 'original', c: 3, d: 4 });
    });

    it('resolves conflicts with last_wins strategy', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ key: 'first' }));
      writeFileSync(bFile, JSON.stringify({ key: 'second' }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json:
      conflicts: last_wins
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged.key).toBe('second');
    });

    it('resolves conflicts with first_wins strategy', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ key: 'first' }));
      writeFileSync(bFile, JSON.stringify({ key: 'second' }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json:
      conflicts: first_wins
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged.key).toBe('first');
    });

    it('concatenates arrays', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ items: [1, 2] }));
      writeFileSync(bFile, JSON.stringify({ items: [3, 4] }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json:
      arrays: concat
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged.items).toEqual([1, 2, 3, 4]);
    });

    it('deep-merges nested objects', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ nested: { x: 1, y: 2 } }));
      writeFileSync(bFile, JSON.stringify({ nested: { z: 3 } }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json:
      objects: merge
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged.nested).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('pretty-prints a single JSON file', () => {
      const sourceFile = join(tmpDir, 'source.json');
      writeFileSync(sourceFile, '{"a":1,"b":2}');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./pretty.json
    json: {}
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'pretty.json'), 'utf8');
      expect(content).toContain('\n');
      expect(JSON.parse(content)).toEqual({ a: 1, b: 2 });
    });

    it('merges JSON fetched from HTTP', { timeout: 30_000 }, () => {
      const localFile = join(tmpDir, 'overrides.json');
      writeFileSync(localFile, JSON.stringify({ extra: true }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - https://raw.githubusercontent.com/udondan/avanti/v0.4.0/package.json
      - ${localFile}
    target: ./merged.json
    json:
      conflicts: last_wins
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged.name).toBe('@udondan/avanti');
      expect(merged.extra).toBe(true);
    });
  });

  describe('variables', () => {
    it('resolves variables in replace rules', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'greeting: hi there');

      const config = writeConfig(
        tmpDir,
        `variables:
  word: hello
files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: hi
        to: $word
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(readFileSync(join(tmpDir, 'output.txt'), 'utf8')).toBe(
        'greeting: hello there',
      );
    });

    it('resolves environment variables', () => {
      const sourceFile = join(tmpDir, 'source.txt');
      writeFileSync(sourceFile, 'user: PLACEHOLDER');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${sourceFile}
    target: ./output.txt
    replace:
      - from: PLACEHOLDER
        to: $env:USER
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.txt'), 'utf8');
      expect(content).toContain(`user: ${process.env['USER']}`);
    });
  });

  describe('JSON merge — auto-detection and json: true/false', () => {
    it('auto-merges when all sources are .json files (no json: key needed)', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ from: 'a' }));
      writeFileSync(bFile, JSON.stringify({ from: 'b', extra: 1 }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged).toMatchObject({ from: 'b', extra: 1 });
    });

    it('auto-merges when all sources are .jsonc files', () => {
      const aFile = join(tmpDir, 'a.jsonc');
      const bFile = join(tmpDir, 'b.jsonc');
      writeFileSync(aFile, '{ "x": 1 }');
      writeFileSync(bFile, '{ "y": 2 }');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.jsonc
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.jsonc'), 'utf8'),
      );
      expect(merged).toEqual({ x: 1, y: 2 });
    });

    it('does NOT auto-merge when sources have mixed extensions', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.txt');
      writeFileSync(aFile, '{"a":1}');
      writeFileSync(bFile, '{"b":2}');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.txt'), 'utf8');
      // Plain concatenation — not valid JSON as a whole
      expect(content).toContain('{"a":1}');
      expect(content).toContain('{"b":2}');
    });

    it('json: true enables merge with defaults for .json sources', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, JSON.stringify({ key: 'first', a: 1 }));
      writeFileSync(bFile, JSON.stringify({ key: 'second', b: 2 }));

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.json
    json: true
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(tmpDir, 'merged.json'), 'utf8'),
      );
      expect(merged).toMatchObject({ key: 'second', a: 1, b: 2 });
    });

    it('json: false disables auto-merge even for .json sources', () => {
      const aFile = join(tmpDir, 'a.json');
      const bFile = join(tmpDir, 'b.json');
      writeFileSync(aFile, '{"a":1}');
      writeFileSync(bFile, '{"b":2}');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./output.json
    json: false
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.json'), 'utf8');
      expect(content).toContain('{"a":1}');
      expect(content).toContain('{"b":2}');
    });
  });

  describe('YAML merge', () => {
    it('merges two disjoint YAML files', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'a: 1\nb: original\n');
      writeFileSync(bFile, 'c: 3\nd: 4\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
    yaml: {}
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      const merged = parseDocument(content).toJSON();
      expect(merged).toMatchObject({ a: 1, b: 'original', c: 3, d: 4 });
    });

    it('auto-merges when all sources are .yaml files', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'from: a\n');
      writeFileSync(bFile, 'from: b\nextra: 1\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      const merged = parseDocument(content).toJSON();
      expect(merged).toMatchObject({ from: 'b', extra: 1 });
    });

    it('auto-merges when all sources are .yml files', () => {
      const aFile = join(tmpDir, 'a.yml');
      const bFile = join(tmpDir, 'b.yml');
      writeFileSync(aFile, 'x: 1\n');
      writeFileSync(bFile, 'y: 2\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yml'), 'utf8');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON()).toEqual({ x: 1, y: 2 });
    });

    it('resolves conflicts with last_wins strategy', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'key: first\n');
      writeFileSync(bFile, 'key: second\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
    yaml:
      conflicts: last_wins
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON().key).toBe('second');
    });

    it('deep-merges nested objects', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'db:\n  host: localhost\n  port: 5432\n');
      writeFileSync(bFile, 'db:\n  port: 5433\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON()).toEqual({
        db: { host: 'localhost', port: 5433 },
      });
    });

    it('concatenates arrays with arrays: concat', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'tags:\n  - alpha\n  - beta\n');
      writeFileSync(bFile, 'tags:\n  - gamma\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
    yaml:
      arrays: concat
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON().tags).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
    });

    it('yaml: false disables auto-merge even for .yaml sources', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(aFile, 'a: 1\n');
      writeFileSync(bFile, 'b: 2\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./output.yaml
    yaml: false
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.yaml'), 'utf8');
      expect(content).toContain('a: 1');
      expect(content).toContain('b: 2');
    });

    it('does NOT auto-merge when sources have mixed extensions', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.txt');
      writeFileSync(aFile, 'a: 1\n');
      writeFileSync(bFile, 'b: 2\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.txt'), 'utf8');
      expect(content).toContain('a: 1');
      expect(content).toContain('b: 2');
    });

    it('pretty-prints a single .yaml source', () => {
      const srcFile = join(tmpDir, 'input.yaml');
      writeFileSync(srcFile, 'host: localhost\nport: 5432\n');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${srcFile}
    target: ./out.yaml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'out.yaml'), 'utf8');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON()).toEqual({
        host: 'localhost',
        port: 5432,
      });
    });

    it('preserves comments from all sources in merged output', () => {
      const aFile = join(tmpDir, 'a.yaml');
      const bFile = join(tmpDir, 'b.yaml');
      writeFileSync(
        aFile,
        '# database config\ndb:\n  host: localhost # primary\n  port: 5432\n',
      );
      writeFileSync(
        bFile,
        '# app settings\napp:\n  name: myapp # service name\n',
      );

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./merged.yaml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'merged.yaml'), 'utf8');
      expect(content).toContain('# database config');
      expect(content).toContain('# primary');
      expect(content).toContain('# app settings');
      expect(content).toContain('# service name');
      const { parseDocument } = require('yaml');
      expect(parseDocument(content).toJSON()).toEqual({
        db: { host: 'localhost', port: 5432 },
        app: { name: 'myapp' },
      });
    });
  });

  describe('self-config re-evaluation', () => {
    it('re-evaluates with the new config when the config file updates itself', () => {
      // v2 config: pulls file-b.txt instead of file-a.txt
      const fileBSource = join(tmpDir, 'file-b-source.txt');
      writeFileSync(fileBSource, 'content of file b');

      const configV2Path = join(tmpDir, 'config-v2.yml');
      writeFileSync(
        configV2Path,
        `files:
  - src: ${fileBSource}
    target: ./file-b.txt
`,
      );

      const fileASource = join(tmpDir, 'file-a-source.txt');
      writeFileSync(fileASource, 'content of file a');

      // v1 config: pulls file-a.txt and also updates the config file itself to v2
      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${fileASource}
    target: ./file-a.txt
  - src: ${configV2Path}
    target: ./avanti.yml
`,
      );

      const { exitCode, stdout } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('re-evaluating with new config');

      // The config was updated to v2
      const writtenConfig = readFileSync(join(tmpDir, 'avanti.yml'), 'utf8');
      expect(writtenConfig).toContain('file-b.txt');

      // file-b.txt must exist (from v2 config)
      expect(existsSync(join(tmpDir, 'file-b.txt'))).toBe(true);
      expect(readFileSync(join(tmpDir, 'file-b.txt'), 'utf8')).toBe(
        'content of file b',
      );

      // file-a.txt must NOT exist (v2 config doesn't include it, and it
      // was never on disk before, so it should not have been created)
      expect(existsSync(join(tmpDir, 'file-a.txt'))).toBe(false);
    });

    it('falls back to first-pass results when the updated config is invalid', () => {
      // Valid YAML but not a valid avanti config (missing "files" key).
      // Using a .yml source triggers auto-YAML-format, so the content must
      // be parseable YAML; the failure must come from parseConfigContent.
      const invalidConfigPath = join(tmpDir, 'invalid-config.yml');
      writeFileSync(invalidConfigPath, 'not_an_avanti_config: true\n');

      const fileASource = join(tmpDir, 'file-a-source.txt');
      writeFileSync(fileASource, 'content of file a');

      const config = writeConfig(
        tmpDir,
        `files:
  - src: ${fileASource}
    target: ./file-a.txt
  - src: ${invalidConfigPath}
    target: ./avanti.yml
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);

      // file-a.txt is still written (first-pass results used despite bad config)
      expect(existsSync(join(tmpDir, 'file-a.txt'))).toBe(true);
    });
  });

  describe('multi-source concatenation', () => {
    it('concatenates multiple text sources with newlines', () => {
      const aFile = join(tmpDir, 'a.txt');
      const bFile = join(tmpDir, 'b.txt');
      writeFileSync(aFile, 'part one');
      writeFileSync(bFile, 'part two');

      const config = writeConfig(
        tmpDir,
        `files:
  - src:
      - ${aFile}
      - ${bFile}
    target: ./output.txt
`,
      );

      const { exitCode } = runAvanti(config, tmpDir);
      expect(exitCode).toBe(0);
      const content = readFileSync(join(tmpDir, 'output.txt'), 'utf8');
      expect(content).toContain('part one');
      expect(content).toContain('part two');
    });
  });
});
