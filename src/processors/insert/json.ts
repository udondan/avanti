/** Insert mode for JSON/JSONC targets. */
import { parse as parseJson, stringify as stringifyJson } from 'comment-json';
import { mergeJson } from '../json';
import { deepRemove, objectAdapter } from './deep-remove';
import { isPlainObject, parseNewContrib } from './util';

// ── JSON removal (comment-json, preserves comments on retained keys) ─────────

type CommentJsonValue = ReturnType<typeof parseJson>;

function parseExistingJson(
  existingContent: string,
): Record<string, CommentJsonValue> {
  try {
    return parseJson(existingContent) as Record<string, CommentJsonValue>;
  } catch (err) {
    throw new Error(
      `insert mode: existing file is not valid JSON/JSONC: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function removeJsonContribution(
  existingContent: string,
  processedText: string,
  lastProcessed: string,
  opts: Record<string, unknown>,
): string {
  const existingParsed = parseExistingJson(existingContent);
  try {
    const oldContrib = parseJson(lastProcessed) as Record<string, unknown>;
    if (isPlainObject(existingParsed) && isPlainObject(oldContrib)) {
      const newContrib = parseNewContrib(processedText, opts, parseJson);
      deepRemove(objectAdapter, existingParsed, oldContrib, newContrib);
    }
  } catch {
    // Corrupted history fragment — skip key removal, fall through to merge
  }
  return stringifyJson(existingParsed, null, 2);
}

export function applyJsonInsert(
  existingContent: string,
  processedText: string,
  lastProcessed: string | null,
  opts: Record<string, unknown>,
): string {
  const cleanedJson =
    lastProcessed === null
      ? existingContent
      : removeJsonContribution(
          existingContent,
          processedText,
          lastProcessed,
          opts,
        );
  return mergeJson([cleanedJson, processedText], opts);
}
