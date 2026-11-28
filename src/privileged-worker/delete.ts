/** delete: unlink a regular file or symlink. */
import * as fs from 'fs';
import * as path from 'path';
import { errnoCode } from './fs-helpers';
import type { DeleteOp, DispatchResult } from './types';

export function handleDelete(op: DeleteOp): DispatchResult {
  const resolved = path.resolve(op.targetPath);
  try {
    const lst = fs.lstatSync(resolved);
    if (!lst.isFile() && !lst.isSymbolicLink()) {
      throw new Error(
        `delete: ${op.targetPath} is not a regular file or symlink; refusing to unlink`,
      );
    }
    fs.unlinkSync(resolved);
  } catch (e) {
    const ec = errnoCode(e);
    if (ec === 'ENOENT') {
      // File already absent — treat as a successful no-op.
      return { kind: 'skipped' };
    }
    if (ec === 'EISDIR') {
      // A concurrent process replaced the file with a directory between
      // lstatSync and unlinkSync. Re-throw with a clear message so the caller
      // does not see a confusing raw EISDIR from Node.
      throw new Error(
        `delete: ${op.targetPath} was replaced by a directory between type-check and unlink; cannot delete`,
        { cause: e },
      );
    }
    throw e;
  }
  return { kind: 'ok' };
}
