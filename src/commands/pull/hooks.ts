/** Runs the per-file `on:` lifecycle hooks around the pull write. */
import { runHook } from '../../processors/on';
import { closeAllSessions, SudoWorkerSession } from '../../writer';
import { errorMessage } from './common';
import { FileHookContext } from './types';

function hookEnv(ctx: FileHookContext): Record<string, string> {
  return {
    AVANTI_TARGET: ctx.targetPath,
    AVANTI_IS_NEW: String(ctx.isNew),
  };
}

function beforeHooks(ctx: FileHookContext): [string, string | undefined][] {
  return [
    ['beforeWrite', ctx.hooks.beforeWrite],
    ctx.isNew
      ? ['beforeCreate', ctx.hooks.beforeCreate]
      : ['beforeUpdate', ctx.hooks.beforeUpdate],
  ];
}

/** Runs the before* hooks; a failing hook aborts the pull. */
export function runBeforeHooks(
  contexts: FileHookContext[],
  sessions: Map<true | string, SudoWorkerSession>,
): void {
  for (const ctx of contexts) {
    const env = hookEnv(ctx);
    for (const [key, script] of beforeHooks(ctx)) {
      if (!script) continue;
      try {
        runHook(script, env);
      } catch (err: unknown) {
        closeAllSessions(sessions);
        console.error(
          `Hook ${key} failed for ${ctx.targetPath}: ${errorMessage(err)}`,
        );
        process.exit(2);
      }
    }
  }
}

/**
 * Runs the create/update hooks. At most one post-write hook runs per file
 * (create or update), and the loop stops at the first failure, whose message
 * is returned.
 */
export function runPostWriteHooks(contexts: FileHookContext[]): string | null {
  for (const ctx of contexts) {
    const key = ctx.isNew ? 'create' : 'update';
    const script = ctx.hooks[key];
    if (!script) continue;
    try {
      runHook(script, hookEnv(ctx));
    } catch (err: unknown) {
      return `Hook ${key} failed for ${ctx.targetPath}: ${errorMessage(err)}`;
    }
  }
  return null;
}
