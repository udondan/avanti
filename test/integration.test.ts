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
