import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  computeDiff,
  computeDeleteDiff,
  computeSymlinkDiff,
  buildNewSymlinkDiff,
  formatDiff,
} from '../src/diff';
import { resolveTargetPath } from '../src/paths';

// Platform-agnostic working directory and root for tests.
// os.tmpdir() is a valid absolute path on every OS.
const wdir = path.join(os.tmpdir(), 'avanti-test-project');
const root = path.parse(wdir).root;

describe('resolveTargetPath', () => {
  it('resolves relative target relative to workingDir', () => {
    expect(resolveTargetPath({ target: 'out.txt' }, 'ignored', wdir)).toBe(
      path.join(wdir, 'out.txt'),
    );
  });

  it('resolves relative directory target with relPath', () => {
    expect(resolveTargetPath({ target: 'scripts/' }, 'foo/bar.sh', wdir)).toBe(
      path.join(wdir, 'scripts', 'foo', 'bar.sh'),
    );
  });

  it('resolves with no target using relPath', () => {
    expect(resolveTargetPath({}, 'renovate.json', wdir)).toBe(
      path.join(wdir, 'renovate.json'),
    );
  });

  it('throws when relative target escapes workingDir via ../', () => {
    expect(() =>
      resolveTargetPath({ target: '../../etc/passwd' }, '', wdir),
    ).toThrow('escapes working directory');
  });

  it('throws on absolute target that escapes workingDir', () => {
    const absTarget = path.join(root, 'etc', 'passwd');
    expect(() => resolveTargetPath({ target: absTarget }, '', wdir)).toThrow(
      'escapes working directory',
    );
  });

  it('allows absolute target within workingDir', () => {
    const absTarget = path.join(wdir, 'foo.txt');
    expect(resolveTargetPath({ target: absTarget }, '', wdir)).toBe(absTarget);
  });

  it('allows absolute target when workingDir is root', () => {
    const absTarget = path.join(root, 'etc', 'hosts');
    expect(resolveTargetPath({ target: absTarget }, '', root)).toBe(absTarget);
  });

  it('allows absolute directory target when workingDir is root', () => {
    const absDir = path.join(root, 'etc', 'conf') + path.sep;
    expect(resolveTargetPath({ target: absDir }, 'my.conf', root)).toBe(
      path.join(root, 'etc', 'conf', 'my.conf'),
    );
  });

  it('resolves variables in target', () => {
    expect(
      resolveTargetPath({ target: 'dir/$team/file.json' }, '', wdir, {
        team: 'backend',
      }),
    ).toBe(path.join(wdir, 'dir', 'backend', 'file.json'));
  });

  it('resolves env vars in target', () => {
    const prior = process.env['TEST_TEAM'];
    process.env['TEST_TEAM'] = 'frontend';
    try {
      expect(
        resolveTargetPath({ target: 'dir/$env:TEST_TEAM/file.json' }, '', wdir),
      ).toBe(path.join(wdir, 'dir', 'frontend', 'file.json'));
    } finally {
      if (prior === undefined) delete process.env['TEST_TEAM'];
      else process.env['TEST_TEAM'] = prior;
    }
  });

  it('throws on undefined variable in target', () => {
    expect(() =>
      resolveTargetPath({ target: 'dir/$missing/file.json' }, '', wdir),
    ).toThrow('Undefined variable: $missing');
  });

  it('throws when ~/ target is outside workingDir', () => {
    expect(() =>
      resolveTargetPath({ target: '~/.opencode/AGENTS.md' }, 'ignored', wdir),
    ).toThrow('escapes working directory');
  });

  it('throws when ~/ directory target is outside workingDir', () => {
    expect(() =>
      resolveTargetPath({ target: '~/.config/avanti/' }, 'foo.yml', wdir),
    ).toThrow('escapes working directory');
  });

  it('allows ~/ target when workingDir is home directory', () => {
    const home = os.homedir();
    expect(
      resolveTargetPath({ target: '~/.opencode/AGENTS.md' }, 'ignored', home),
    ).toBe(path.join(home, '.opencode', 'AGENTS.md'));
  });

  it('allows ~/ directory target when workingDir is home directory', () => {
    const home = os.homedir();
    expect(
      resolveTargetPath({ target: '~/.config/avanti/' }, 'foo.yml', home),
    ).toBe(path.join(home, '.config', 'avanti', 'foo.yml'));
  });

  it('throws when ~/ target escapes home directory via ..', () => {
    expect(() =>
      resolveTargetPath({ target: '~/../../etc/hosts' }, '', wdir),
    ).toThrow('escapes home directory');
  });
});

// ── computeDiff ───────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-diff-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks a new file (target does not exist) with isNew: true and hasChanges: true', () => {
    const result = computeDiff(
      path.join(tmpDir, 'new.txt'),
      Buffer.from('hello'),
    );
    expect(result.isNew).toBe(true);
    expect(result.hasChanges).toBe(true);
  });

  it('marks an unchanged file with hasChanges: false', () => {
    const file = path.join(tmpDir, 'same.txt');
    fs.writeFileSync(file, 'unchanged');
    const result = computeDiff(file, Buffer.from('unchanged'));
    expect(result.hasChanges).toBe(false);
    expect(result.isNew).toBe(false);
  });

  it('marks a modified file with hasChanges: true and includes old/new lines in patch', () => {
    const file = path.join(tmpDir, 'modified.txt');
    fs.writeFileSync(file, 'old content\n');
    const result = computeDiff(file, Buffer.from('new content\n'));
    expect(result.hasChanges).toBe(true);
    expect(result.isNew).toBe(false);
    expect(result.patch).toContain('-old content');
    expect(result.patch).toContain('+new content');
  });

  it('detects binary new content and sets isBinary: true with empty patch', () => {
    const file = path.join(tmpDir, 'text.txt');
    fs.writeFileSync(file, 'text');
    const binary = Buffer.concat([Buffer.alloc(1), Buffer.from('DATA')]);
    const result = computeDiff(file, binary);
    expect(result.isBinary).toBe(true);
    expect(result.patch).toBe('');
  });

  it('detects binary existing file and sets isBinary: true', () => {
    const file = path.join(tmpDir, 'bin.dat');
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(1), Buffer.from('X')]));
    const result = computeDiff(file, Buffer.from('new text'));
    expect(result.isBinary).toBe(true);
  });
});

// ── computeDeleteDiff ─────────────────────────────────────────────────────────

describe('computeDeleteDiff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-diff-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a deletion patch for an existing text file', () => {
    const file = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(file, 'to be deleted\n');
    const result = computeDeleteDiff(file);
    expect(result.hasChanges).toBe(true);
    expect(result.patch).toContain('-to be deleted');
  });

  it('returns hasChanges: false when the file does not exist', () => {
    const result = computeDeleteDiff(path.join(tmpDir, 'missing.txt'));
    expect(result.hasChanges).toBe(false);
    expect(result.patch).toBe('');
  });

  it('sets isBinary: true and hasChanges: true for a binary file being deleted', () => {
    const file = path.join(tmpDir, 'bin.dat');
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(1), Buffer.from('X')]));
    const result = computeDeleteDiff(file);
    expect(result.isBinary).toBe(true);
    expect(result.isDelete).toBe(true);
    expect(result.hasChanges).toBe(true);
  });
});

// ── formatDiff ────────────────────────────────────────────────────────────────

describe('formatDiff', () => {
  it('returns an empty string when hasChanges is false', () => {
    expect(
      formatDiff({
        targetPath: '/f',
        isNew: false,
        hasChanges: false,
        contentChanged: false,
        patch: '',
      }),
    ).toBe('');
  });

  it('includes --- and +++ header lines for a new text file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-fmt-'));
    try {
      const d = computeDiff(
        path.join(tmpDir, 'nonexistent.txt'),
        Buffer.from('new content\n'),
      );
      const output = formatDiff(d);
      expect(output).toContain('---');
      expect(output).toContain('+++');
      expect(output).toContain('+new content');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows "new binary file" label for a new binary file', () => {
    const output = formatDiff({
      targetPath: '/path/to/img.png',
      isNew: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    });
    expect(output).toContain('new binary file');
    expect(output).toContain('/dev/null');
  });

  it('shows "binary file deleted" label for a deleted binary file', () => {
    const output = formatDiff({
      targetPath: '/path/to/img.png',
      isNew: false,
      isDelete: true,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    });
    expect(output).toContain('binary file deleted');
    expect(output).toContain('/dev/null');
  });

  it('shows "binary file changed" label for a changed binary file', () => {
    const output = formatDiff({
      targetPath: '/path/to/img.png',
      isNew: false,
      hasChanges: true,
      contentChanged: true,
      patch: '',
      isBinary: true,
    });
    expect(output).toContain('binary file changed');
  });
});

// ── mode change detection ─────────────────────────────────────────────────────

describe('computeDiff — mode changes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-diff-mode-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'detects a mode mismatch on an existing file',
    () => {
      const file = path.join(tmpDir, 'script.sh');
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o644);
      const result = computeDiff(file, Buffer.from('#!/bin/sh\n'), '0755');
      expect(result.hasChanges).toBe(true);
      expect(result.contentChanged).toBe(false);
      expect(result.modeChange).toBeDefined();
      expect(result.modeChange!.to).toBe(0o755);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports no modeChange when the mode already matches',
    () => {
      const file = path.join(tmpDir, 'script.sh');
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o755);
      const result = computeDiff(file, Buffer.from('#!/bin/sh\n'), '0755');
      expect(result.hasChanges).toBe(false);
      expect(result.modeChange).toBeUndefined();
    },
  );

  it('does not set modeChange for a new file', () => {
    const result = computeDiff(
      path.join(tmpDir, 'new.sh'),
      Buffer.from('#!/bin/sh\n'),
      '0755',
    );
    expect(result.isNew).toBe(true);
    expect(result.modeChange).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'does not set modeChange when the target is a symlink',
    () => {
      const target = path.join(tmpDir, 'real.sh');
      const link = path.join(tmpDir, 'link.sh');
      fs.writeFileSync(target, '#!/bin/sh\n');
      fs.chmodSync(target, 0o644);
      fs.symlinkSync(target, link);
      const result = computeDiff(link, Buffer.from('#!/bin/sh\n'), '0755');
      expect(result.modeChange).toBeUndefined();
    },
  );
});

// ── computeSymlinkDiff / buildNewSymlinkDiff ──────────────────────────────────

describe('buildNewSymlinkDiff', () => {
  it('returns isNew: true, hasChanges: true, isSymlink: true with patch containing the target', () => {
    const result = buildNewSymlinkDiff('/some/link', '/etc/hosts');
    expect(result.isNew).toBe(true);
    expect(result.hasChanges).toBe(true);
    expect(result.isSymlink).toBe(true);
    expect(result.patch).toContain('-> /etc/hosts');
  });
});

describe('computeSymlinkDiff — directory case', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-symlink-diff-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'returns isDirectory: true when the target path is a directory',
    () => {
      const dir = path.join(tmpDir, 'existing-dir');
      fs.mkdirSync(dir);
      const result = computeSymlinkDiff(dir, '/etc/hosts');
      expect(result.isDirectory).toBe(true);
      expect(result.isSymlink).toBe(true);
      expect(result.hasChanges).toBe(true);
    },
  );
});

describe('formatDiff — mode changes', () => {
  it.skipIf(process.platform === 'win32')(
    'shows old mode / new mode for a mode-only change',
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-fmt-mode-'));
      try {
        const file = path.join(tmpDir, 'script.sh');
        fs.writeFileSync(file, '#!/bin/sh\n');
        fs.chmodSync(file, 0o644);
        const d = computeDiff(file, Buffer.from('#!/bin/sh\n'), '0755');
        const output = formatDiff(d);
        expect(output).toContain('old mode');
        expect(output).toContain('new mode');
        expect(output).toContain('0755');
        expect(output).not.toContain('@@');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shows both mode change and content diff when both changed',
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanti-fmt-mode-'));
      try {
        const file = path.join(tmpDir, 'script.sh');
        fs.writeFileSync(file, 'old\n');
        fs.chmodSync(file, 0o644);
        const d = computeDiff(file, Buffer.from('new\n'), '0755');
        const output = formatDiff(d);
        expect(output).toContain('old mode');
        expect(output).toContain('new mode');
        expect(output).toContain('-old');
        expect(output).toContain('+new');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
