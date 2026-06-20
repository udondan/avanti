import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sudoAtomicWrite,
  sudoAtomicRead,
  SudoWriteTarget,
} from '../src/writer';

// This test only runs when AVANTI_SUDO_TEST_DIR is set to a root-owned directory.
// In CI the directory is /usr/local/avanti-sudo-test (created by the workflow step).
// Locally: sudo mkdir -p /usr/local/avanti-sudo-test && sudo chmod 700 /usr/local/avanti-sudo-test
//           AVANTI_SUDO_TEST_DIR=/usr/local/avanti-sudo-test bun test test/privileged-worker.sudo-integration.test.ts
const sudoTestDir = process.env.AVANTI_SUDO_TEST_DIR;
const sudoCallLog = process.env.SUDO_CALL_LOG;

// Named-user sudo integration: AVANTI_SUDO_NAMED_USER is a non-root Unix user
// that NOPASSWD sudo is granted for in CI (e.g. "www-data" on Ubuntu runners).
// AVANTI_SUDO_NAMED_USER_DIR must be a directory writable by that user and
// readable by the test runner (so assertions can read the output files).
// In CI: sudo useradd -m testwriter && sudo -u testwriter mkdir /tmp/avanti-named-test
//         AVANTI_SUDO_NAMED_USER=testwriter AVANTI_SUDO_NAMED_USER_DIR=/tmp/avanti-named-test
const sudoNamedUser = process.env.AVANTI_SUDO_NAMED_USER;
const sudoNamedUserDir = process.env.AVANTI_SUDO_NAMED_USER_DIR;

describe.skipIf(!sudoTestDir || process.platform === 'win32')(
  'privileged worker — real sudo',
  () => {
    beforeEach(() => {
      if (sudoCallLog) {
        fs.writeFileSync(sudoCallLog, '');
      }
    });

    it('writes 3 files with exactly 1 sudo invocation', async () => {
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

      await sudoAtomicWrite(targets);

      // The key assertion: sudo was called exactly once for all 3 files.
      // Checked immediately after the write, before any read operations below
      // that would add their own sudo calls to the log.
      if (sudoCallLog) {
        const log = fs.readFileSync(sudoCallLog, 'utf8');
        const calls = log.split('\n').filter(Boolean);
        expect(calls).toHaveLength(1);
      }

      // Verify all files landed with correct content. Batch all 3 reads into a
      // single sudoAtomicRead call so the privileged reader itself adds at most
      // one more log entry (separate from the count assertion above).
      const allReads = await sudoAtomicRead(
        targets.map((t) => ({ filePath: t.targetPath, sudo: true })),
      );
      for (const t of targets) {
        let body: string | null = null;
        try {
          body = fs.readFileSync(t.targetPath, 'utf8');
        } catch {
          const r = allReads.get(t.targetPath);
          if (r) body = Buffer.from(r.contentB64, 'base64').toString('utf8');
        }
        if (body !== null) {
          expect(body).toBe(t.content.toString('utf8'));
        } else {
          expect(
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
    });
  },
);

describe.skipIf(
  !sudoNamedUser || !sudoNamedUserDir || process.platform === 'win32',
)('privileged worker — named-user sudo', () => {
  beforeEach(() => {
    if (sudoCallLog) {
      fs.writeFileSync(sudoCallLog, '');
    }
  });

  it('writes a file via sudo -u <user>, exercising the worker binary copy path', async () => {
    // This test exercises the code path in runPrivilegedWorker that is unique
    // to named-user sudo: the worker binary is copied into a world-readable
    // /tmp subdirectory before exec, and the node executable may be resolved
    // from PATH instead of process.execPath. Neither of these paths is covered
    // by the root-sudo test above.
    const runId = crypto.randomBytes(4).toString('hex');
    const targetPath = path.join(sudoNamedUserDir!, `named-${runId}.txt`);
    const content = `named-user-content-${runId}`;

    const targets: SudoWriteTarget[] = [
      {
        targetPath,
        content: Buffer.from(content),
        sudo: sudoNamedUser!,
      },
    ];

    await sudoAtomicWrite(targets);

    // The file must exist and contain the expected content.
    // Read via the named user's sudo if the test runner can't read it directly.
    let body: string | null = null;
    try {
      body = fs.readFileSync(targetPath, 'utf8');
    } catch {
      const reads = await sudoAtomicRead([
        { filePath: targetPath, sudo: sudoNamedUser! },
      ]);
      const r = reads.get(targetPath);
      if (r) body = Buffer.from(r.contentB64, 'base64').toString('utf8');
    }
    expect(body).toBe(content);

    // Exactly one sudo invocation for one target.
    if (sudoCallLog) {
      const log = fs.readFileSync(sudoCallLog, 'utf8');
      const calls = log.split('\n').filter(Boolean);
      expect(calls).toHaveLength(1);
    }
  });
});
