#!/usr/bin/env node
import { Command } from 'commander';
import { diffCommand } from './commands/diff';
import { pullCommand } from './commands/pull';
import { version } from '../package.json';

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
  );

program.addCommand(diffCommand());
program.addCommand(pullCommand());

program.parse(process.argv);
