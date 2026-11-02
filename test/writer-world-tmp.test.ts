import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// AVANTI_WORLD_TMP is validated once, when the writer module is loaded, so each
// case sets the variable and imports a fresh copy of the module.
async function loadWriter(): Promise<typeof import('../src/writer')> {
  vi.resetModules();
  return import('../src/writer');
}

describe.skipIf(process.platform === 'win32')(
  'AVANTI_WORLD_TMP validation',
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-world-tmp-'));
    });

    afterEach(() => {
      delete process.env.AVANTI_WORLD_TMP;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('accepts a private directory', async () => {
      const dir = path.join(tmpDir, 'private');
      fs.mkdirSync(dir, { mode: 0o700 });
      process.env.AVANTI_WORLD_TMP = dir;
      const writer = await loadWriter();
      expect(typeof writer.atomicWrite).toBe('function');
    });

    it('accepts a world-writable directory with the sticky bit', async () => {
      const dir = path.join(tmpDir, 'sticky');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o1777);
      process.env.AVANTI_WORLD_TMP = dir;
      await expect(loadWriter()).resolves.toBeDefined();
    });

    it('rejects a world-writable directory without the sticky bit', async () => {
      const dir = path.join(tmpDir, 'open');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o777);
      process.env.AVANTI_WORLD_TMP = dir;
      await expect(loadWriter()).rejects.toThrow(
        'is world-writable without the sticky bit',
      );
    });

    it('rejects a path that does not exist', async () => {
      process.env.AVANTI_WORLD_TMP = path.join(tmpDir, 'missing');
      await expect(loadWriter()).rejects.toThrow(
        `AVANTI_WORLD_TMP=${path.join(tmpDir, 'missing')} does not exist`,
      );
    });

    it('rethrows other lstat errors', async () => {
      const file = path.join(tmpDir, 'file');
      fs.writeFileSync(file, '');
      process.env.AVANTI_WORLD_TMP = path.join(file, 'sub');
      await expect(loadWriter()).rejects.toMatchObject({ code: 'ENOTDIR' });
    });
  },
);
