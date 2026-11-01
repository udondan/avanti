// Shared helpers for the in-process pull/lock command tests. Runs a command
// through Commander in the test process, captures console output and turns
// process.exit() into a recorded exit code.
import { Command, Option } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

export class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface RunResult {
  /** Code of the first process.exit() call; 0 when the action returned. */
  code: number;
  stdout: string;
  stderr: string;
  /** Anything other than process.exit() that the action threw. */
  thrown?: unknown;
}

export async function runCommand(
  command: Command,
  args: string[],
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const fmt = (a: unknown[]): string => a.map(String).join(' ');
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      out.push(fmt(a));
    }),
    vi.spyOn(console, 'error').mockImplementation((...a) => {
      err.push(fmt(a));
    }),
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      err.push(fmt(a));
    }),
  ];
  let code: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
    c?: number,
  ) => {
    code ??= c ?? 0;
    throw new ExitError(c ?? 0);
  }) as typeof process.exit);

  const program = new Command()
    .exitOverride()
    .option('-c, --config <path>')
    .option('-w, --working-dir <path>')
    .addOption(new Option('--via <transport>').choices(['api', 'cli']));
  program.addCommand(command);

  let thrown: unknown;
  try {
    await program.parseAsync(['node', 'avanti', ...args]);
  } catch (e) {
    if (!(e instanceof ExitError)) thrown = e;
  } finally {
    for (const s of spies) s.mockRestore();
    exitSpy.mockRestore();
  }
  return {
    code: code ?? 0,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    thrown,
  };
}

export interface TempEnv {
  root: string;
  work: string;
  history: string;
  configPath: string;
  writeConfig(content: string): string;
  cleanup(): void;
}

/** Creates a temp root with a working dir and history dir and points
 *  AVANTI_HISTORY_DIR at it. The config lives inside the working dir. */
export function makeTempEnv(prefix: string): TempEnv {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `avanti-${prefix}-`)),
  );
  const work = path.join(root, 'work');
  const history = path.join(root, 'history');
  fs.mkdirSync(work);
  fs.mkdirSync(history);
  const prevHistory = process.env.AVANTI_HISTORY_DIR;
  process.env.AVANTI_HISTORY_DIR = history;
  const configPath = path.join(work, 'avanti.yml');
  return {
    root,
    work,
    history,
    configPath,
    writeConfig(content: string): string {
      fs.writeFileSync(configPath, content);
      return configPath;
    },
    cleanup(): void {
      if (prevHistory === undefined) delete process.env.AVANTI_HISTORY_DIR;
      else process.env.AVANTI_HISTORY_DIR = prevHistory;
      // Restore permissions so rmSync can remove locked-down fixtures.
      const unlock = (p: string): void => {
        let st: fs.Stats | undefined;
        try {
          st = fs.lstatSync(p);
        } catch {
          return;
        }
        if (st.isSymbolicLink()) return;
        try {
          fs.chmodSync(p, 0o755);
        } catch {
          // ignore
        }
        if (st.isDirectory()) {
          for (const c of fs.readdirSync(p)) unlock(path.join(p, c));
        }
      };
      unlock(root);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Throws a value that is not an Error, to reach the `String(err)` arm of
 *  the commands' catch blocks. */
export function throwNonError(value: string): never {
  const thrown: unknown = value;
  throw thrown;
}
