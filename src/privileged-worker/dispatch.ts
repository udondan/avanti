/** Routes each op to its handler. */
import { handleChmod } from './chmod';
import { handleDelete } from './delete';
import { handleRead, handleReadlink, handleStatRead } from './read';
import type { DispatchResult, WriteOp } from './types';
import { handleWriteInPlace } from './write-in-place';
import { handleWriteMv } from './write-mv';
import { handleWriteSymlink } from './write-symlink';

type OpHandler<T extends WriteOp> = (
  op: T,
  trustedUids?: Set<number>,
) => DispatchResult;

type HandlerTable = {
  [K in WriteOp['type']]: OpHandler<Extract<WriteOp, { type: K }>>;
};

const HANDLERS: HandlerTable = {
  'write-mv': (op, trustedUids) => {
    handleWriteMv(op, trustedUids);
    return { kind: 'ok' };
  },
  'write-in-place': (op, trustedUids) => {
    handleWriteInPlace(op, trustedUids);
    return { kind: 'ok' };
  },
  'write-symlink': (op, trustedUids) => {
    handleWriteSymlink(op, trustedUids);
    return { kind: 'ok' };
  },
  delete: handleDelete,
  chmod: handleChmod,
  read: handleRead,
  readlink: handleReadlink,
  'stat-read': handleStatRead,
};

export function dispatch(
  op: WriteOp,
  trustedUids?: Set<number>,
): DispatchResult {
  // Own-property check: op.type comes from untrusted JSON and must never
  // resolve to an inherited Object.prototype member.
  if (!Object.hasOwn(HANDLERS, op.type)) {
    throw new Error(`unknown op type: ${op.type}`);
  }
  const handler = HANDLERS[op.type] as OpHandler<WriteOp>;
  return handler(op, trustedUids);
}
