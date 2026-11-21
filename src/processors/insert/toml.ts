/** Insert mode for TOML targets. */
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { mergeToml } from '../toml';
import { deepRemove, objectAdapter } from './deep-remove';
import { parseNewContrib } from './util';

// ── TOML removal (plain objects) ─────────────────────────────────────────────

type TomlObject = Record<string, unknown>;

function parseExistingToml(existingContent: string): TomlObject {
  try {
    return parseToml(existingContent);
  } catch (err) {
    throw new Error(
      `insert mode: existing file is not valid TOML: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function removeTomlContribution(
  existingContent: string,
  processedText: string,
  lastProcessed: string,
  opts: Record<string, unknown>,
): string {
  const existingParsed = parseExistingToml(existingContent);
  try {
    const oldContrib = parseToml(lastProcessed) as Record<string, unknown>;
    const newContrib = parseNewContrib(processedText, opts, parseToml);
    deepRemove(objectAdapter, existingParsed, oldContrib, newContrib);
  } catch {
    // Corrupted history fragment — skip key removal, fall through to merge
  }
  return stringifyToml(existingParsed);
}

export function applyTomlInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  const cleanedToml =
    lastProcessed === null
      ? existingContent
      : removeTomlContribution(
          existingContent,
          processedText,
          lastProcessed,
          opts,
        );
  return mergeToml([cleanedToml, processedText], opts);
}
