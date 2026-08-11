import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { resolveVariablesAndEnvironment } from '../src/context';
import { isWindows } from '../src/shell';

const cwd = process.cwd();

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-context-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveVariablesAndEnvironment', () => {
  it('resolves an environment: entry that depends on a variables: entry', async () => {
    const { vars, env } = await resolveVariablesAndEnvironment(
      { prefix: 'tok' },
      { TOKEN: '$prefix-secret' },
      cwd,
    );
    expect(vars.TOKEN).toBe('tok-secret');
    expect(env.TOKEN).toBe('tok-secret');
  });

  it('resolves a variables: entry that depends on an environment: entry declared later in the object', async () => {
    const { vars, env } = await resolveVariablesAndEnvironment(
      { header: 'Bearer $TOKEN' },
      { TOKEN: 'abc123' },
      cwd,
    );
    expect(vars.header).toBe('Bearer abc123');
    expect(env.TOKEN).toBe('abc123');
  });

  it('exposes an environment: entry as a plain $NAME variable (dual exposure)', async () => {
    const { vars } = await resolveVariablesAndEnvironment(
      {},
      { GREETING: 'hello' },
      cwd,
    );
    expect(vars.GREETING).toBe('hello');
    expect(process.env.GREETING).toBe('hello');
    delete process.env.GREETING;
  });

  it('resolves a multi-hop chain spanning both blocks', async () => {
    const { vars, env } = await resolveVariablesAndEnvironment(
      { c: 'base', a: '$b-top' },
      { b: '$c-mid' },
      cwd,
    );
    expect(vars.c).toBe('base');
    expect(vars.b).toBe('base-mid');
    expect(vars.a).toBe('base-mid-top');
    expect(env.b).toBe('base-mid');
  });

  it('throws naming the cycle chain for a var-to-var cycle', async () => {
    await expect(
      resolveVariablesAndEnvironment({ a: '$b', b: '$a' }, {}, cwd),
    ).rejects.toThrow(
      'Circular dependency: variables.a → variables.b → variables.a',
    );
  });

  it('throws naming the cycle chain for an env-to-env cycle', async () => {
    await expect(
      resolveVariablesAndEnvironment({}, { X: '$Y', Y: '$X' }, cwd),
    ).rejects.toThrow(
      'Circular dependency: environment.X → environment.Y → environment.X',
    );
  });

  it('throws naming the cycle chain for a mixed var/env cycle', async () => {
    await expect(
      resolveVariablesAndEnvironment({ a: '$b' }, { b: '$a' }, cwd),
    ).rejects.toThrow(
      'Circular dependency: variables.a → environment.b → variables.a',
    );
  });

  it('throws on a self-referencing variable', async () => {
    await expect(
      resolveVariablesAndEnvironment({ a: '$a' }, {}, cwd),
    ).rejects.toThrow('Circular dependency: variables.a → variables.a');
  });

  it('throws on a self-referencing environment entry via $env:', async () => {
    await expect(
      resolveVariablesAndEnvironment({}, { A: '$env:A' }, cwd),
    ).rejects.toThrow('Circular dependency: environment.A → environment.A');
  });

  it('resolves an ambient $env:X reference with no graph edge required', async () => {
    process.env.AVANTI_TEST_AMBIENT = 'ambient-value';
    try {
      const { vars } = await resolveVariablesAndEnvironment(
        { greeting: 'hi $env:AVANTI_TEST_AMBIENT' },
        {},
        cwd,
      );
      expect(vars.greeting).toBe('hi ambient-value');
    } finally {
      delete process.env.AVANTI_TEST_AMBIENT;
    }
  });

  it('does not create a graph edge for $env:NAME referencing a variables:-only name', async () => {
    delete process.env.TOKEN;
    await expect(
      resolveVariablesAndEnvironment(
        { TOKEN: 'declared-as-variable', greeting: '$env:TOKEN' },
        {},
        cwd,
      ),
    ).rejects.toThrow('Undefined environment variable: $env:TOKEN');
  });

  it('resolves eligible nodes in declaration order (variables then environment)', async () => {
    const orderFile = path.join(tmpDir, 'order.txt');
    fs.writeFileSync(orderFile, '');
    const append = (marker: string) =>
      isWindows
        ? `Add-Content -NoNewline -Path '${orderFile}' -Value '${marker}'`
        : `printf '${marker}' >> '${orderFile}'`;

    await resolveVariablesAndEnvironment(
      {
        first: { src: { exec: append('1') } },
        second: { src: { exec: append('2') } },
      },
      {
        THIRD: { src: { exec: append('3') } },
        FOURTH: { src: { exec: append('4') } },
      },
      cwd,
    );

    expect(fs.readFileSync(orderFile, 'utf8')).toBe('1234');
  });
});
