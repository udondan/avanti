import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveEnvironmentEntry,
  validateEnvironmentNames,
} from '../src/environment';

describe('validateEnvironmentNames', () => {
  it('accepts valid names', () => {
    expect(() => validateEnvironmentNames({ A_1: 'x', _b: 'y' })).not.toThrow();
  });

  it('rejects names avanti injects itself', () => {
    expect(() => validateEnvironmentNames({ AVANTI_TARGET: 'x' })).toThrow(
      'Environment variable name "AVANTI_TARGET" is reserved and cannot be used',
    );
  });

  it('rejects names outside the $env: grammar', () => {
    expect(() => validateEnvironmentNames({ '1BAD': 'x' })).toThrow(
      'Environment variable name "1BAD" is invalid',
    );
  });
});

describe('resolveEnvironmentEntry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves variables in plain string values', async () => {
    await expect(
      resolveEnvironmentEntry('E', 'v=$v', { v: '1' }, tmpDir),
    ).resolves.toBe('v=1');
  });

  it('prefixes variable errors with the entry name', async () => {
    await expect(
      resolveEnvironmentEntry('E', '$missing', {}, tmpDir),
    ).rejects.toThrow('environment.E: Undefined variable');
  });

  it('returns the trimmed content of a single-file source', async () => {
    await expect(
      resolveEnvironmentEntry('E', { src: { raw: '  value\n' } }, {}, tmpDir),
    ).resolves.toBe('value');
  });

  it('wraps fetch failures', async () => {
    await expect(
      resolveEnvironmentEntry(
        'E',
        { src: { path: path.join(tmpDir, 'missing.txt') } },
        {},
        tmpDir,
      ),
    ).rejects.toThrow('environment.E: failed to fetch source:');
  });

  it('rejects sources without content', async () => {
    const dir = path.join(tmpDir, 'empty');
    fs.mkdirSync(dir);
    await expect(
      resolveEnvironmentEntry('E', { src: { path: dir } }, {}, tmpDir),
    ).rejects.toThrow('environment.E: source resolved to no content');
  });

  it('rejects sources with several files', async () => {
    const dir = path.join(tmpDir, 'two');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    await expect(
      resolveEnvironmentEntry('E', { src: { path: dir } }, {}, tmpDir),
    ).rejects.toThrow('environment.E: source resolved to multiple files');
  });

  it('rejects binary content', async () => {
    const file = path.join(tmpDir, 'bin');
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    await expect(
      resolveEnvironmentEntry('E', { src: { path: file } }, {}, tmpDir),
    ).rejects.toThrow('environment.E: source resolved to binary content');
  });
});
