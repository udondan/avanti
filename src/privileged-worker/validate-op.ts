/** Validation of untrusted ops before they are dispatched. */
import * as path from 'path';
import { checkAncestorsSafeAsRoot } from './ancestors';
import type { WriteOp } from './types';

// Required string fields per op type, checked in this order.
const REQUIRED_STRING_FIELDS = new Map<string, readonly string[]>([
  ['write-mv', ['contentB64', 'defaultMode']],
  ['write-in-place', ['contentB64', 'defaultMode']],
  ['write-symlink', ['symlinkTarget']],
  ['chmod', ['mode']],
]);

// Op types that never write a backup, so their backupPath is not checked.
const NO_BACKUP_TYPES = new Set<string>([
  'delete',
  'chmod',
  'read',
  'readlink',
  'stat-read',
]);

function validateTargetPath(raw: Record<string, unknown>, type: string): void {
  const targetPath = raw['targetPath'];
  if (typeof targetPath !== 'string') {
    throw new Error(`invalid op ${type}: missing required field "targetPath"`);
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error(
      `invalid op ${type}: targetPath must be absolute, got ${targetPath}`,
    );
  }
  // Reject paths with .. components: path.resolve normalises them
  // differently from how isAbsolute treats them, so checkAncestorsSafeAsRoot
  // would walk different ancestors than dispatch writes to.
  if (path.resolve(targetPath) !== targetPath) {
    throw new Error(
      `invalid op ${type}: targetPath must be canonical (no .. components), got ${targetPath}`,
    );
  }
}

/**
 * Validates required fields before dispatching so errors are actionable.
 * Throws on the first problem found.
 */
export function validateOp(op: unknown): asserts op is WriteOp {
  if (typeof op !== 'object' || op === null) {
    throw new Error(`invalid op: expected object, got ${typeof op}`);
  }
  const raw = op as Record<string, unknown>;
  const type = raw['type'];
  if (typeof type !== 'string') {
    throw new Error(`invalid op: missing required field "type"`);
  }
  validateTargetPath(raw, type);
  const backupPath = raw['backupPath'];
  if (typeof backupPath === 'string' && !path.isAbsolute(backupPath)) {
    throw new Error(
      `invalid op ${type}: backupPath must be absolute, got ${backupPath}`,
    );
  }
  for (const field of REQUIRED_STRING_FIELDS.get(type) ?? []) {
    if (typeof raw[field] !== 'string') {
      throw new Error(`invalid op ${type}: missing required field "${field}"`);
    }
  }
}

/** Checks the target's (and, for writes, the backup's) ancestor directories. */
export function checkOpAncestors(
  op: WriteOp,
  trustedUids: Set<number>,
  checkedDirs: Set<string>,
): void {
  checkAncestorsSafeAsRoot(
    op.targetPath,
    trustedUids,
    'destination',
    checkedDirs,
  );
  const backupPath = (op as { backupPath?: string }).backupPath;
  if (!NO_BACKUP_TYPES.has(op.type) && backupPath) {
    checkAncestorsSafeAsRoot(backupPath, trustedUids, 'backup', checkedDirs);
  }
}
