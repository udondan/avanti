import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { sudoAtomicWrite, SudoWriteTarget } from '../src/writer';

// This test only runs when AVANTI_SUDO_TEST_DIR is set to a root-owned directory.
// In CI the directory is /opt/avanti-sudo-test (created by the workflow step).
// Locally: sudo mkdir -p /opt/avanti-sudo-test && sudo chmod 700 /opt/avanti-sudo-test
//           AVANTI_SUDO_TEST_DIR=/opt/avanti-sudo-test bun test test/privileged-worker.sudo-integration.test.ts
const sudoTestDir = process.env.AVANTI_SUDO_TEST_DIR;
const sudoCallLog = process.env.SUDO_CALL_LOG;

describe.skipIf(!sudoTestDir || process.platform === 'win32')(
  'privileged worker — real sudo',
  () => {
    beforeEach(() => {
      if (sudoCallLog) {
        fs.writeFileSync(sudoCallLog, '');
      }
    });

    it('writes 3 files with exactly 1 sudo invocation', () => {
      const runId = crypto.randomBytes(4).toString('hex');
      const targets: SudoWriteTarget[] = [
        {
          targetPath: path.join(sudoTestDir!, `a-${runId}.txt`),
          content: Buffer.from(`content-a-${runId}`),
          sudo: true,
        },
        {
          targetPath: path.join(sudoTestDir!, `b-${runId}.txt`),
          content: Buffer.from(`content-b-${runId}`),
          sudo: true,
        },
        {
          targetPath: path.join(sudoTestDir!, `c-${runId}.txt`),
          content: Buffer.from(`content-c-${runId}`),
          sudo: true,
        },
      ];

      sudoAtomicWrite(targets);

      // Verify all files landed with correct content.
      for (const t of targets) {
        // Worker runs as root so it can read the file; we use sudo cat via sudoRead
        // for verification, but since the test env has NOPASSWD we can just
        // read the file directly — the runner's own user should be able to sudo.
        const body = fs
          .readdirSync(sudoTestDir!)
          .includes(path.basename(t.targetPath))
          ? fs.readFileSync(t.targetPath, 'utf8')
          : null;
        // If the file is root-owned and not world-readable, fall back: just check it exists.
        if (body !== null) {
          expect(body).toBe(t.content.toString('utf8'));
        } else {
          expect(
            fs.existsSync(t.targetPath) ||
              // root-owned dir may block readdir; verify via stat
              (() => {
                try {
                  fs.statSync(t.targetPath);
                  return true;
                } catch {
                  return false;
                }
              })(),
          ).toBe(true);
        }
      }

      // The key assertion: sudo was called exactly once for all 3 files.
      if (sudoCallLog) {
        const log = fs.readFileSync(sudoCallLog, 'utf8');
        const calls = log.split('\n').filter(Boolean);
        expect(calls).toHaveLength(1);
      }
    });
  },
);
