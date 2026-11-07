import { Command } from 'commander';
import { printDiffs } from '../diff';
import type { HistoryManager, PullLogEntry } from '../history';
import type { FileAtPull } from '../history/types';
import { openProjectHistory } from './project';
import {
  applyRestorePlan,
  confirmApply,
  createRestorePlan,
  planPreAvantiRestore,
  planVersionRestore,
  type RestorePlan,
} from './restore';

type Snapshot = Map<string, FileAtPull>;

function findTargetPullId(
  pulls: PullLogEntry[],
  pullId: string | undefined,
): string {
  if (pullId === undefined) {
    // Undo the last pull: restore state from before it (second entry, or pre-avanti)
    return pulls[0].pullId;
  }
  const matched = pulls.find(
    (p) => p.pullId === pullId || p.pullId.startsWith(pullId),
  );
  if (!matched) {
    console.error(`No pull found matching ID "${pullId}".`);
    process.exit(2);
  }
  return matched.pullId;
}

// When undoing the last pull, we want the state BEFORE it — i.e. the second pull's state
// When reverting TO a specific pull, we want the state AFTER that pull
function targetSnapshot(
  history: HistoryManager,
  pulls: PullLogEntry[],
  pullId: string | undefined,
  targetPullId: string,
): Snapshot {
  if (pullId !== undefined) return history.getFilesAtPull(targetPullId);

  // Undo last pull: use the second-most-recent pull as target, or if none, pre-avanti
  const snapshot: Snapshot =
    pulls.length > 1
      ? history.getFilesAtPull(pulls[1].pullId)
      : new Map<string, FileAtPull>(); // no prior pull → everything goes to pre-avanti state

  // A file with wasNew=true in the last pull was created from scratch (it
  // did not exist on disk before that pull ran). Even if an earlier pull
  // also created it, the correct "before last pull" state is: not present.
  for (const ref of pulls[0].files) {
    if (ref.wasNew) {
      snapshot.delete(ref.absolutePath);
    }
  }
  return snapshot;
}

function buildRevertPlan(
  history: HistoryManager,
  snapshot: Snapshot,
): RestorePlan {
  const plan = createRestorePlan();
  for (const meta of history.listTrackedFiles()) {
    const entry = snapshot.get(meta.absolutePath);
    if (entry === undefined) {
      // File was not present at target pull — go to pre-avanti state
      planPreAvantiRestore(plan, history, meta);
      continue;
    }
    // File existed at target pull — restore that version
    const content = history.readVersion(meta.absolutePath, entry.version);
    if (content === null) continue;
    planVersionRestore(
      plan,
      meta,
      content,
      entry.isSymlink ? 'symlink' : undefined,
    );
  }
  return plan;
}

export function revertCommand(): Command {
  return new Command('revert')
    .description(
      'Atomically revert all project files to a past pull state (defaults to undoing the last pull)',
    )
    .argument(
      '[pullId]',
      'short or full pull ID to revert to (from avanti log)',
    )
    .option('-y, --yes', 'skip confirmation prompt')
    .action(
      async (pullId: string | undefined, options: unknown, cmd: Command) => {
        const opts = options as { yes?: boolean };
        const history = openProjectHistory(cmd);
        if (!history.hasHistory()) {
          console.error('No history found. Run avanti pull first.');
          process.exit(2);
        }

        const pulls = history.listPulls(); // newest first
        if (pulls.length === 0) {
          console.log('No pull history recorded yet.');
          process.exit(0);
        }

        const targetPullId = findTargetPullId(pulls, pullId);
        const snapshot = targetSnapshot(history, pulls, pullId, targetPullId);
        const plan = buildRevertPlan(history, snapshot);

        if (plan.diffs.length === 0 && !plan.hasError) {
          console.log(
            'Nothing to revert — files already match the target state.',
          );
          process.exit(0);
        }

        const shortId = targetPullId.slice(0, 8);
        const label =
          pullId === undefined
            ? `Undoing last pull (${shortId})`
            : `Reverting to state after pull ${shortId}`;
        console.log(`${label}:\n`);
        if (plan.diffs.length > 0) {
          printDiffs(plan.diffs);
        }

        if (plan.hasError) process.exit(2);

        await confirmApply(opts.yes);

        const total =
          plan.writeTargets.length +
          plan.deletions.length +
          plan.sudoDeletions.size;
        await applyRestorePlan(plan, {
          action: 'revert',
          pastTense: 'reverted',
          failurePrefix: 'Revert failed',
          success: `Reverted ${total} file(s).`,
        });
      },
    );
}
