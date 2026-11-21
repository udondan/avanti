import * as crypto from 'crypto';
import { FileSrc, Variables } from '../types';
import { baseLabelForSrc, expectedShaForSrc, filterForSrc } from './dispatch';

export interface SourceFetchRecord {
  sourceLabel: string;
  observedSha: string;
  expectedSha: string | undefined;
  matched: boolean;
}

/** Orders strings by UTF-16 code units, like the default `Array#sort`. */
export function compareCodeUnits(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

// labelForSrc returns the source label used in SourceFetchRecord. Structured
// sources (github:, gitlab:, etc.) keep variable references unresolved so the
// label matches the literal YAML values that applyUpdatedShas reads for SHA
// writeback. Plain-string sources resolve variables since they don't support
// SHA pinning. When a filter is present a NUL-byte separator (\x00) is used
// before "filter:<json>" so the label is unambiguous even if the base contains
// the display string " | filter:" (e.g. a local path with that literal text).
// Use formatSourceLabel() to convert to a human-readable form for display.
export function labelForSrc(src: FileSrc, vars: Variables): string {
  const base = baseLabelForSrc(src, vars);
  const filter = filterForSrc(src);
  if (filter && filter.length > 0)
    return `${base}\x00filter:${JSON.stringify(filter)}`;
  return base;
}

// formatSourceLabel converts an internal label (which may contain a NUL-byte
// filter separator) into a human-readable string for log/error output.
export function formatSourceLabel(label: string): string {
  return label.replace('\x00filter:', ' | filter:');
}

function shaSupported(src: FileSrc): src is Exclude<FileSrc, string> {
  if (typeof src === 'string') return false; // local paths excluded; plain string HTTP has no sha field
  if ('raw' in src) return false;
  return true;
}

function computeFilesSha(files: Map<string, Buffer>): string {
  // Always include filename in the hash so a rename/path change affects the SHA
  // consistently, whether the source resolves to one file or many.
  const hash = crypto.createHash('sha256');
  const sorted = Array.from(files.entries()).sort(([a], [b]) =>
    compareCodeUnits(a, b),
  );
  for (const [k, v] of sorted) {
    hash.update(k.replace(/\\/g, '/'), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(v);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

export function buildRecord(
  src: FileSrc,
  files: Map<string, Buffer>,
  vars: Variables,
): SourceFetchRecord | null {
  if (!shaSupported(src)) return null;
  const observedSha = computeFilesSha(files);
  const expectedSha = expectedShaForSrc(src);
  return {
    sourceLabel: labelForSrc(src, vars),
    observedSha,
    expectedSha,
    matched: expectedSha === undefined || expectedSha === observedSha,
  };
}
