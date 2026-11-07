import { FileSrc, Variables } from '../../types';

/** A structured (map) source, i.e. any `src` value that is not a plain string. */
export type ObjectSrc = Exclude<FileSrc, string>;

/**
 * Every structured source type, identified by its type key. The first key
 * present on a source object determines its type.
 */
export const SOURCE_KINDS = [
  'raw',
  'path',
  'url',
  'http',
  'exec',
  'gitlab',
  'github',
  'bitbucket',
  'git',
  'aws_s3',
  'aws_secrets_manager',
  'aws_systems_manager_parameter',
  'vault',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

type SrcOfKind<K extends SourceKind> = Extract<ObjectSrc, Record<K, unknown>>;

export interface FetchContext {
  workingDir: string;
  vars: Variables;
  configBase?: string;
}

export interface RawFetchResult {
  files: Map<string, Buffer>;
  skipped?: boolean;
}

/** Per-source-type behaviour used by the source dispatcher. */
export interface SourceDescriptor<S> {
  /** File name used for format auto-detection; omitted → `null`. */
  filename?(src: S): string | null;
  /** Label with unresolved variables, used for SHA writeback. */
  label(src: S): string;
  /** Fully-resolved key for the fetch cache. */
  cacheKey(src: S, vars: Variables): string;
  /** Pinned SHA; omitted → `undefined`. */
  expectedSha?(src: S): string | undefined;
  /** Post-fetch filter patterns; omitted → `undefined`. */
  filter?(src: S): string[] | undefined;
  /** Called from the async `fetchRawSrc`, so sync throws still reject. */
  fetch(src: S, ctx: FetchContext): RawFetchResult | Promise<RawFetchResult>;
}

export type DescriptorMap<K extends SourceKind> = {
  [P in K]: SourceDescriptor<SrcOfKind<P>>;
};
