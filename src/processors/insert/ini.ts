/** Insert mode for INI targets, with ownership tracking. */
import { parseIniDoc, mergeIni, type IniDocument } from '../ini';
import { iniContribDiff, iniDocToJs } from './ini-common';
import { removeIniOwnership } from './ini-owned-remove';
import { isIniOwnership, type IniOwnership } from './ini-owned';
import { computeIniOwnership } from './ini-ownership';
import { emptyIniSnapshot, snapshotIni } from './ini-snapshot';
import { deepRemoveFromIniDoc } from './ini-remove';
import type { InsertHistory, InsertResult } from './types';
import { isLastWins } from './util';

function parseExistingIni(existingContent: string): IniDocument {
  try {
    return parseIniDoc(existingContent);
  } catch (err) {
    throw new Error(
      `insert mode: existing file is not valid INI: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function parseNewIni(processedText: string): Record<string, unknown> {
  let newParsed: Record<string, unknown> = {};
  try {
    newParsed = iniDocToJs(parseIniDoc(processedText));
  } catch {
    // unparseable processedText → no new keys (old behaviour)
  }
  return newParsed;
}

interface RemovalScope {
  newContrib: Record<string, unknown> | null;
  newKeys: ReadonlySet<string>;
  kept: Set<object>;
}

// Older history only has the fragment text. A missing target got it as is; an
// existing file got it merged with the same options, which collapses repeated
// keys to the value that was written (the first one under conflicts:
// first_wins). Remove the fragment as is, then the values only the merged form
// has. Under conflicts: abort that merge rejects a fragment that repeats a key:
// only the fragment itself is used then.
function removeIniFragment(
  doc: IniDocument,
  processed: string,
  opts: Record<string, unknown>,
  scope: RemovalScope,
): void {
  const { newContrib, newKeys, kept } = scope;
  const oldContrib = iniDocToJs(parseIniDoc(processed));
  let mergedOnly: Record<string, unknown> = {};
  try {
    const merged = parseIniDoc(mergeIni(['', processed], opts));
    mergedOnly = iniContribDiff(oldContrib, iniDocToJs(merged));
  } catch {
    // abort rejected a repeated key
  }
  deepRemoveFromIniDoc(doc, oldContrib, newContrib, newKeys, kept);
  deepRemoveFromIniDoc(doc, mergedOnly, newContrib, newKeys, kept);
}

function removeIniContribution(
  doc: IniDocument,
  processedText: string,
  last: InsertHistory,
  opts: Record<string, unknown>,
  kept: Set<object>,
): void {
  const newParsed = parseNewIni(processedText);
  const newContrib = isLastWins(opts) ? newParsed : null;
  // Keys whose emptied last section may stay for the merge to refill:
  // under any conflict strategy, except with objects: replace, where an
  // empty section would conflict with the new one instead of being filled.
  const newKeys = new Set(
    Object.keys(opts['objects'] === 'replace' ? (newContrib ?? {}) : newParsed),
  );
  if (isIniOwnership(last.owned)) {
    removeIniOwnership(doc, last.owned, newContrib, newKeys, kept);
  } else {
    removeIniFragment(doc, last.processed, opts, { newContrib, newKeys, kept });
  }
}

export function applyIniInsert(
  existingContent: string,
  processedText: string,
  last: InsertHistory | null,
  opts: Record<string, unknown>,
): InsertResult {
  const doc = parseExistingIni(existingContent);
  // Nodes that held the previous contribution and stay for the merge to refill.
  const kept = new Set<object>();
  if (last !== null) {
    try {
      removeIniContribution(doc, processedText, last, opts, kept);
    } catch {
      // Corrupted history fragment — skip key removal, fall through to merge
    }
  }
  const snap = snapshotIni(doc, kept);
  // Passed as a document, so emptied array nodes keep their position and the
  // merge changes `doc` in place.
  const text = mergeIni([doc, processedText], opts);
  return { text, owned: computeIniOwnership(doc, snap) };
}

// What a missing target gets: the contribution is written as is, so all of
// it is owned.
export function iniOwnershipOfNewFile(
  processedText: string,
): IniOwnership | undefined {
  try {
    const doc = parseIniDoc(processedText);
    return computeIniOwnership(doc, emptyIniSnapshot());
  } catch {
    return undefined;
  }
}
