import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { evaluateCondition, evaluateConditions } from '../src/condition';
import { isWindows } from '../src/shell';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'avanti-condition-'));
const existingFile = path.join(tmpDir, 'exists.txt');
writeFileSync(existingFile, 'hello');
const existingDir = path.join(tmpDir, 'subdir');
mkdirSync(existingDir);
const missingPath = path.join(tmpDir, 'missing.txt');

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function spoofPlatform(platform: string) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(
    platform as NodeJS.Platform,
  );
}

describe('evaluateCondition', () => {
  describe('os', () => {
    it('passes when os matches current platform', () => {
      spoofPlatform('linux');
      expect(evaluateCondition({ os: 'linux' }, '', {})).toBe(true);
    });

    it('fails when os does not match', () => {
      spoofPlatform('linux');
      expect(evaluateCondition({ os: 'mac' }, '', {})).toBe(false);
    });

    it('maps darwin → mac', () => {
      spoofPlatform('darwin');
      expect(evaluateCondition({ os: 'mac' }, '', {})).toBe(true);
    });

    it('maps win32 → windows', () => {
      spoofPlatform('win32');
      expect(evaluateCondition({ os: 'windows' }, '', {})).toBe(true);
    });

    it('passes when current platform is in the list', () => {
      spoofPlatform('linux');
      expect(evaluateCondition({ os: ['linux', 'mac'] }, '', {})).toBe(true);
    });

    it('fails when current platform is not in the list', () => {
      spoofPlatform('win32');
      expect(evaluateCondition({ os: ['linux', 'mac'] }, '', {})).toBe(false);
    });
  });

  describe('exists', () => {
    it('passes when path exists (file)', () => {
      expect(evaluateCondition({ exists: existingFile }, '', {})).toBe(true);
    });

    it('passes when path exists (directory)', () => {
      expect(evaluateCondition({ exists: existingDir }, '', {})).toBe(true);
    });

    it('fails when path does not exist', () => {
      expect(evaluateCondition({ exists: missingPath }, '', {})).toBe(false);
    });

    it('resolves variables in exists path', () => {
      expect(
        evaluateCondition({ exists: '$dir/exists.txt' }, '', { dir: tmpDir }),
      ).toBe(true);
    });
  });

  describe('exec', () => {
    it('passes when command exits 0', () => {
      if (isWindows) return;
      expect(evaluateCondition({ exec: 'true' }, '', {})).toBe(true);
    });

    it('fails when command exits non-zero', () => {
      if (isWindows) return;
      expect(evaluateCondition({ exec: 'false' }, '', {})).toBe(false);
    });

    it('resolves variables in exec command', () => {
      if (isWindows) return;
      expect(
        evaluateCondition({ exec: 'test -f $path' }, '', {
          path: existingFile,
        }),
      ).toBe(true);
    });
  });

  describe('target_exists', () => {
    it('passes when target exists', () => {
      expect(evaluateCondition({ target_exists: true }, existingFile, {})).toBe(
        true,
      );
    });

    it('fails when target does not exist', () => {
      expect(evaluateCondition({ target_exists: true }, missingPath, {})).toBe(
        false,
      );
    });
  });

  describe('not', () => {
    it('inverts a passing condition', () => {
      spoofPlatform('linux');
      expect(evaluateCondition({ os: 'linux', not: true }, '', {})).toBe(false);
    });

    it('inverts a failing condition', () => {
      spoofPlatform('linux');
      expect(evaluateCondition({ os: 'mac', not: true }, '', {})).toBe(true);
    });

    it('inverts exists check', () => {
      expect(
        evaluateCondition({ exists: missingPath, not: true }, '', {}),
      ).toBe(true);
    });

    it('inverts exec check', () => {
      if (isWindows) return;
      expect(evaluateCondition({ exec: 'false', not: true }, '', {})).toBe(
        true,
      );
    });
  });

  describe('AND of multiple fields', () => {
    it('passes when all checks pass', () => {
      spoofPlatform('linux');
      expect(
        evaluateCondition({ os: 'linux', exists: existingFile }, '', {}),
      ).toBe(true);
    });

    it('fails when one check fails', () => {
      spoofPlatform('linux');
      expect(
        evaluateCondition({ os: 'linux', exists: missingPath }, '', {}),
      ).toBe(false);
    });
  });
});

describe('evaluateConditions', () => {
  it('passes with no conditions', () => {
    expect(evaluateConditions(undefined, undefined, '', {})).toBe(true);
  });

  it('applies if condition (AND)', () => {
    spoofPlatform('linux');
    expect(evaluateConditions({ os: 'linux' }, undefined, '', {})).toBe(true);
    expect(evaluateConditions({ os: 'mac' }, undefined, '', {})).toBe(false);
  });

  it('applies if as list — all must pass', () => {
    spoofPlatform('linux');
    expect(
      evaluateConditions(
        [{ os: 'linux' }, { exists: existingFile }],
        undefined,
        '',
        {},
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [{ os: 'linux' }, { exists: missingPath }],
        undefined,
        '',
        {},
      ),
    ).toBe(false);
  });

  it('applies ifAny condition (OR) — passes when any matches', () => {
    spoofPlatform('linux');
    expect(
      evaluateConditions(undefined, [{ os: 'mac' }, { os: 'linux' }], '', {}),
    ).toBe(true);
  });

  it('applies ifAny condition (OR) — fails when none match', () => {
    spoofPlatform('linux');
    expect(
      evaluateConditions(undefined, [{ os: 'mac' }, { os: 'windows' }], '', {}),
    ).toBe(false);
  });

  it('requires both if and ifAny to pass', () => {
    spoofPlatform('linux');
    expect(
      evaluateConditions({ os: 'linux' }, [{ exists: existingFile }], '', {}),
    ).toBe(true);
    expect(
      evaluateConditions({ os: 'mac' }, [{ exists: existingFile }], '', {}),
    ).toBe(false);
    expect(
      evaluateConditions({ os: 'linux' }, [{ exists: missingPath }], '', {}),
    ).toBe(false);
  });

  it('supports not in ifAny entries', () => {
    spoofPlatform('linux');
    expect(
      evaluateConditions(
        undefined,
        [{ os: 'windows', not: true }, { os: 'mac' }],
        '',
        {},
      ),
    ).toBe(true);
  });
});
