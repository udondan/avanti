#!/usr/bin/env node
import { Command } from 'commander';
import { diffCommand } from './commands/diff';
import { pullCommand } from './commands/pull';
import { logCommand } from './commands/log';
import { lockCommand } from './commands/lock';
import { revertCommand } from './commands/revert';
import { resetCommand } from './commands/reset';
import { version } from '../package.json';
import { setVerbose } from './logger';

const program = new Command();

program
  .name('avanti')
  .description(
    'Assemble local files from any source via a declarative YAML spec',
  )
  .version(version)
  .option('-c, --config <path>', 'path to config file')
  .option(
    '-w, --working-dir <path>',
    'working directory for resolving relative paths (default: current directory)',
  )
  .option(
    '--via <transport>',
    'transport for fetching a remote --config: "api" or "cli"',
  )
  .option('-v, --verbose', 'print verbose debug output to stderr');

program.hook('preAction', () => {
  if (program.opts<{ verbose?: boolean }>().verbose) setVerbose(true);
});

program.addCommand(diffCommand());
program.addCommand(pullCommand());
program.addCommand(lockCommand());
program.addCommand(logCommand());
program.addCommand(revertCommand());
program.addCommand(resetCommand());

program.parse(process.argv);
