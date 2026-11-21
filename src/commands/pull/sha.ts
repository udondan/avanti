/** SHA mismatch reporting, merging and pin write-back for pull. */
import { isRemoteConfigSpec } from '../../config';
import { formatSourceLabel } from '../../sources';
import { computeDiff } from '../../diff';
import { applyUpdatedShas, writeUpdatedShas } from '../../config-writeback';
import { errorMessage } from './common';
import { PullRun, ShaError } from './types';

export function printShaErrors(errors: ShaError[]): void {
  for (const e of errors) {
    console.error(
      `SHA mismatch for ${formatSourceLabel(e.sourceLabel)}\n` +
        `  expected: ${e.expectedSha}\n` +
        `  got:      ${e.observedSha}`,
    );
  }
}

/** Appends errors whose source label is not yet present in target. */
export function mergeShaErrors(target: ShaError[], extra: ShaError[]): void {
  const seen = new Set(target.map((e) => e.sourceLabel));
  for (const e of extra) {
    if (!seen.has(e.sourceLabel)) target.push(e);
  }
}

function hasAcceptedMismatches(run: PullRun): boolean {
  return !!run.opts.acceptChanges && run.state.shaErrors.length > 0;
}

/**
 * Warns when --accept-changes is used with a remote config: SHA values
 * cannot be written back, so the mismatch will recur on the next pull.
 */
export function warnRemoteShaAccept(run: PullRun): void {
  if (hasAcceptedMismatches(run) && isRemoteConfigSpec(run.configPath)) {
    console.warn(
      'Warning: config is remote; SHA values cannot be written back. ' +
        'Mismatches accepted for this session only.',
    );
  }
}

interface ShaWriteback {
  updates: Map<string, string> | null;
  preApplied: boolean;
}

/**
 * Pre-applies SHA updates to the config write target in-memory so that both
 * history and the on-disk file reflect the final pinned state in one pass.
 */
export function preApplyConfigShas(run: PullRun): ShaWriteback {
  if (!hasAcceptedMismatches(run) || isRemoteConfigSpec(run.configPath)) {
    return { updates: null, preApplied: false };
  }
  const updates = new Map(
    run.state.shaErrors.map((e) => [e.sourceLabel, e.observedSha]),
  );
  const { writeTargets, allDiffs } = run.state;
  const idx = writeTargets.findIndex((t) => t.targetPath === run.configPath);
  if (idx === -1) return { updates, preApplied: false };
  const patched = applyUpdatedShas(
    writeTargets[idx].content.toString('utf8'),
    updates,
  );
  if (patched === null) return { updates, preApplied: false };
  const patchedBuf = Buffer.from(patched, 'utf8');
  writeTargets[idx] = { ...writeTargets[idx], content: patchedBuf };
  // Recompute diff so staging and atomicWrite both see SHA-patched content,
  // even when the original content diff was empty.
  allDiffs[idx] = computeDiff(writeTargets[idx].targetPath, patchedBuf);
  return { updates, preApplied: true };
}

/**
 * SHA writeback: write updated sha values into config file after all writes
 * complete. Skipped when config was a write target and already patched
 * in-memory.
 */
export function writeBackShas(configPath: string, sha: ShaWriteback): void {
  if (sha.updates === null || sha.preApplied) return;
  try {
    const pinned = writeUpdatedShas(configPath, sha.updates);
    if (pinned)
      console.log(`Updated ${sha.updates.size} SHA pin(s) in config.`);
  } catch (err: unknown) {
    console.warn(
      `Warning: could not update SHA values in config: ${errorMessage(err)}`,
    );
  }
}
