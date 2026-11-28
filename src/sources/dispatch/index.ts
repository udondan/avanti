import { FileSrc, Variables } from '../../types';
import { resolveVars } from '../../variables';
import { BASIC_DESCRIPTORS } from './basic';
import { CLOUD_DESCRIPTORS } from './cloud';
import { FORGE_DESCRIPTORS } from './forge';
import { fetchPlainSrc, plainSrcFilename } from './plain';
import {
  DescriptorMap,
  FetchContext,
  ObjectSrc,
  RawFetchResult,
  SOURCE_KINDS,
  SourceDescriptor,
  SourceKind,
} from './types';

export type { RawFetchResult } from './types';
export { plainLocalPath } from './plain';
export { resolveLocalPathSrc } from './basic';

const DESCRIPTORS: DescriptorMap<SourceKind> = {
  ...BASIC_DESCRIPTORS,
  ...FORGE_DESCRIPTORS,
  ...CLOUD_DESCRIPTORS,
};

function descriptorFor(
  src: ObjectSrc,
): SourceDescriptor<ObjectSrc> | undefined {
  const kind = SOURCE_KINDS.find((k) => k in src);
  return kind === undefined ? undefined : DESCRIPTORS[kind];
}

export function srcFilename(src: FileSrc): string | null {
  if (typeof src === 'string') return plainSrcFilename(src);
  return descriptorFor(src)?.filename?.(src) ?? null;
}

// Plain strings resolve variables; unknown source objects fall back to JSON.
function describeSrc(
  src: FileSrc,
  vars: Variables,
  pick: (descriptor: SourceDescriptor<ObjectSrc>, src: ObjectSrc) => string,
): string {
  if (typeof src === 'string') return resolveVars(src, vars);
  const descriptor = descriptorFor(src);
  return descriptor ? pick(descriptor, src) : JSON.stringify(src);
}

export function baseLabelForSrc(src: FileSrc, vars: Variables): string {
  return describeSrc(src, vars, (d, s) => d.label(s));
}

// cacheKeyForSrc returns a fully-resolved key for FetchCache so that sources
// using variables are correctly distinguished when vars change between
// stabilization iterations, and raw: sources are keyed by their content.
export function cacheKeyForSrc(src: FileSrc, vars: Variables): string {
  return describeSrc(src, vars, (d, s) => d.cacheKey(s, vars));
}

// Plain-string sources have no sha field, so only object sources apply.
export function expectedShaForSrc(src: ObjectSrc): string | undefined {
  return descriptorFor(src)?.expectedSha?.(src);
}

export function filterForSrc(src: FileSrc): string[] | undefined {
  if (typeof src === 'string') return undefined;
  return descriptorFor(src)?.filter?.(src);
}

export async function fetchRawSrc(
  src: FileSrc,
  ctx: FetchContext,
): Promise<RawFetchResult> {
  if (typeof src === 'string') return fetchPlainSrc(src, ctx);
  const descriptor = descriptorFor(src);
  if (descriptor === undefined) {
    throw new Error(`Unknown source type: ${JSON.stringify(src)}`);
  }
  return descriptor.fetch(src, ctx);
}
