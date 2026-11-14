/** Readiness gate of a privileged worker session: settles once the worker connects. */

export interface ReadyGate<T> {
  // Resolves when the worker has connected to the IPC socket and the session
  // is ready for exec() calls. Rejects on spawn error or listen error.
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

// Creates a gate that rejects with timeoutMessage after timeoutMs unless it was
// settled before. onTimeout runs right before that rejection.
export function createReadyGate<T>(
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout: () => void,
): ReadyGate<T> {
  // Both are replaced synchronously by the Promise executor below.
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    // Connection timeout: if the worker never connects to the IPC socket
    // (e.g. sudo hangs on a password prompt that has no TTY, PAM deadlock,
    // or the binary is not found), await this.ready in exec() would hang
    // indefinitely — the exec() timeout fires only AFTER ready resolves.
    // Fail fast so the caller gets a clear error instead of a silent hang.
    const readyTimer = setTimeout(() => {
      onTimeout();
      rej(new Error(timeoutMessage));
    }, timeoutMs);
    readyTimer.unref();
    resolve = (value: T) => {
      clearTimeout(readyTimer);
      res(value);
    };
    reject = (err: Error) => {
      clearTimeout(readyTimer);
      rej(err);
    };
  });
  // Suppress unhandledRejection if the worker fails before exec() attaches
  // a .catch() via await this.ready. exec() will re-reject via its own promise.
  promise.catch(() => undefined);
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (err: Error) => reject(err),
  };
}
