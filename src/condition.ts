import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { Condition, Variables } from './types';
import { resolveVars, resolveVarsShellSafe } from './variables';
import { getShellArgs } from './shell';

export function evaluateCondition(
  cond: Condition,
  getTargetPath: () => string,
  workingDir: string,
  vars: Variables,
): boolean {
  let result = true;

  if (cond.os !== undefined) {
    const platforms = Array.isArray(cond.os) ? cond.os : [cond.os];
    if (!(platforms as string[]).includes(currentPlatform())) result = false;
  }
  if (result && cond.exists !== undefined) {
    let existsPath = resolveVars(cond.exists, vars);
    if (existsPath.startsWith('~/')) {
      existsPath = path.join(os.homedir(), existsPath.slice(2));
    }
    result = existsSync(path.resolve(workingDir, existsPath));
  }
  if (result && cond.exec !== undefined) {
    const { shell, args } = getShellArgs(resolveVarsShellSafe(cond.exec, vars));
    result =
      spawnSync(shell, args, { cwd: workingDir, stdio: 'ignore' }).status === 0;
  }
  if (result && cond.target_exists === true) {
    result = existsSync(getTargetPath());
  }

  return cond.not === true ? !result : result;
}

export function evaluateConditions(
  ifCond: Condition | Condition[] | undefined,
  ifAnyCond: Condition[] | undefined,
  getTargetPath: () => string,
  workingDir: string,
  vars: Variables,
): boolean {
  if (ifCond !== undefined) {
    const list = Array.isArray(ifCond) ? ifCond : [ifCond];
    if (
      !list.every((c) => evaluateCondition(c, getTargetPath, workingDir, vars))
    )
      return false;
  }
  if (
    ifAnyCond !== undefined &&
    !ifAnyCond.some((c) =>
      evaluateCondition(c, getTargetPath, workingDir, vars),
    )
  )
    return false;
  return true;
}

function currentPlatform(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return process.platform;
}
