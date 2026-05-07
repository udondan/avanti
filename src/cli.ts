#!/usr/bin/env node
import { Command } from 'commander';
import { diffCommand } from './commands/diff';
import { pullCommand } from './commands/pull';

const program = new Command();

program
  .name('avanti')
  .description(
    'Assemble local files from any source via a declarative YAML spec',
  )
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config file', 'avanti.yml');

program.addCommand(diffCommand());
program.addCommand(pullCommand());

program.parse(process.argv);
