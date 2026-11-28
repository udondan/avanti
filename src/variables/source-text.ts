/** Shared helpers for resolving variables:/environment: entries. */
import { FileEntry, Variables } from '../types';
import { fetchSource, FetchCache, FetchResult } from '../sources';
import { isBinary } from '../binary';

export interface FetchContext {
  cache?: FetchCache;
  configBase?: string;
}

interface SourceRequest {
  /** Error prefix, e.g. `variables.foo`. */
  scope: string;
  entry: FileEntry;
  vars: Variables;
  workingDir: string;
  ctx: FetchContext;
}

interface SingleTextMessages {
  multiple: string;
  binary: string;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `fn`, prefixing any thrown message with `scope`. The wrapped resolvers
 * only ever throw Error instances.
 */
export function withScope<T>(scope: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`${scope}: ${msg}`, { cause: err });
  }
}

/** Fetches a source that must resolve to exactly one non-binary file. */
export async function fetchSingleText(
  req: SourceRequest,
  messages: SingleTextMessages,
): Promise<{ srcPath: string; text: string }> {
  const { scope } = req;
  let result: FetchResult;
  try {
    result = await fetchSource(req.entry, req.workingDir, req.vars, {
      cache: req.ctx.cache,
      configBase: req.ctx.configBase,
    });
  } catch (err) {
    throw new Error(`${scope}: failed to fetch source: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  if (result.files.size === 0) {
    throw new Error(`${scope}: source resolved to no content`);
  }
  if (result.files.size > 1) {
    throw new Error(`${scope}: ${messages.multiple}`);
  }
  const [srcPath, buf] = result.files.entries().next().value as [
    string,
    Buffer,
  ];
  if (isBinary(buf)) {
    throw new Error(`${scope}: ${messages.binary}`);
  }
  return { srcPath, text: buf.toString('utf8') };
}
