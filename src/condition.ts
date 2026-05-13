import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { Condition, Variables } from './types';
import { resolveVars } from './variables';
import { getShellArgs } from './shell';

export function evaluateCondition(
  cond: Condition,
  targetPath: string,
  vars: Variables,
): boolean {
  let result = true;

  if (cond.os !== undefined) {
    const platforms = Array.isArray(cond.os) ? cond.os : [cond.os];
    if (!(platforms as string[]).includes(currentPlatform())) result = false;
  }
  if (result && cond.exists !== undefined) {
    result = existsSync(resolveVars(cond.exists, vars));
  }
  if (result && cond.exec !== undefined) {
    const { shell, args } = getShellArgs(resolveVars(cond.exec, vars));
    result = spawnSync(shell, args).status === 0;
  }
  if (result && cond.target_exists === true) {
    result = existsSync(targetPath);
  }

  return cond.not === true ? !result : result;
}

export function evaluateConditions(
  ifCond: Condition | Condition[] | undefined,
  ifAnyCond: Condition[] | undefined,
  targetPath: string,
  vars: Variables,
): boolean {
  if (ifCond !== undefined) {
    const list = Array.isArray(ifCond) ? ifCond : [ifCond];
    if (!list.every((c) => evaluateCondition(c, targetPath, vars)))
      return false;
  }
  if (
    ifAnyCond !== undefined &&
    !ifAnyCond.some((c) => evaluateCondition(c, targetPath, vars))
  )
    return false;
  return true;
}

export function conditionsNeedTargetPath(
  ifCond: Condition | Condition[] | undefined,
  ifAnyCond: Condition[] | undefined,
): boolean {
  const all: Condition[] = [
    ...(Array.isArray(ifCond) ? ifCond : ifCond !== undefined ? [ifCond] : []),
    ...(ifAnyCond ?? []),
  ];
  return all.some((c) => c.target_exists === true);
}

function currentPlatform(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return process.platform;
}
