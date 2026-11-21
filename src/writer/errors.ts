/** Errors that report which destination paths landed before a failure. */

// Base for partial-write errors: carries the paths that were successfully
// written before the failure so callers can record partial pull history.
export class PartialWriteError extends Error {
  readonly writtenPaths: string[];
  constructor(message: string, writtenPaths: string[]) {
    super(message);
    this.writtenPaths = writtenPaths;
  }
}

// Thrown by sudoAtomicWrite when at least one write op fails mid-batch.
export class SudoWritePartialError extends PartialWriteError {
  constructor(message: string, writtenPaths: string[]) {
    super(message, writtenPaths);
    this.name = 'SudoWritePartialError';
  }
}

// Thrown by atomicWrite when Phase 3 (rename) or Phase 4 (in-place write) fails
// after some destination paths have already been modified. Callers that record
// pull history can inspect writtenPaths to determine which files actually landed.
export class AtomicWritePartialError extends PartialWriteError {
  constructor(message: string, writtenPaths: string[]) {
    super(message, writtenPaths);
    this.name = 'AtomicWritePartialError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
