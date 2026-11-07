import { Command } from 'commander';
import { printDiffs } from '../diff';
import { openProjectHistory } from './project';
import {
  applyRestorePlan,
  confirmApply,
  createRestorePlan,
  planPreAvantiRestore,
} from './restore';

export function resetCommand(): Command {
  return new Command('reset')
    .description(
      'Restore all tracked files to their pre-avanti state, deleting files avanti created',
    )
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (options: unknown, cmd: Command) => {
      const opts = options as { yes?: boolean };
      const history = openProjectHistory(cmd);
      if (!history.hasHistory()) {
        console.log('No avanti history found. Nothing to reset.');
        process.exit(0);
      }

      const tracked = history.listTrackedFiles();
      if (tracked.length === 0) {
        console.log('No tracked files. Nothing to reset.');
        process.exit(0);
      }

      const plan = createRestorePlan();
      for (const meta of tracked) {
        planPreAvantiRestore(plan, history, meta);
      }

      if (plan.diffs.length === 0 && !plan.hasError) {
        console.log(
          'Files are already at their pre-avanti state. Nothing to reset.',
        );
        process.exit(0);
      }

      const deleted = plan.deletions.length + plan.sudoDeletions.size;
      const total = plan.writeTargets.length + deleted;
      if (total > 0) {
        console.log(
          `This will restore ${total} tracked file(s) to their pre-avanti state:\n`,
        );
      }
      if (plan.diffs.length > 0) {
        printDiffs(plan.diffs);
      }

      if (plan.hasError) process.exit(2);

      await confirmApply(opts.yes);

      await applyRestorePlan(plan, {
        action: 'reset',
        pastTense: 'reset',
        failurePrefix: 'Reset failed',
        success: `Restored ${plan.writeTargets.length} file(s), deleted ${deleted} file(s).`,
      });
    });
}
