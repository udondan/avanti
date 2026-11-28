import type { FileDiff } from '../../diff';
import type { HistoryManager } from '../../history';
import type { SudoWorkerSession, WriteTarget } from '../../writer';
import type { OnHooks } from '../../types';
import type { FetchLoopResult } from './fetch-loop';

export interface PullOptions {
  yes?: boolean;
  acceptChanges?: boolean;
}

export interface ShaError {
  sourceLabel: string;
  expectedSha: string | undefined;
  observedSha: string;
}

export interface FileHookContext {
  targetPath: string;
  hooks: OnHooks;
  isNew: boolean;
}

/** A stale file created by avanti that is no longer produced. */
export interface StaleDelete {
  path: string;
  /** Sudo identity when the file needs privileged deletion */
  sudo: WriteTarget['sudo'];
  /** Index into StalePlan.diffs, to check hasChanges before auth/write */
  diffIndex: number;
}

/** Files from the last pull that are no longer produced by the config. */
export interface StalePlan {
  /** Stale files created by avanti that must be deleted. */
  toDelete: StaleDelete[];
  toRestore: WriteTarget[];
  diffs: FileDiff[];
  /** Parallel array: diffs index for each toRestore entry */
  restoreDiffIndices: number[];
  hasError: boolean;
}

export type PreReads = Map<
  string,
  { contentB64: string; isSymlink?: boolean } | null
>;

/** Everything one pull run carries from fetching to recording history. */
export interface PullRun {
  opts: PullOptions;
  configPath: string;
  history: HistoryManager;
  historyAvailable: boolean;
  pullId: string | null;
  state: FetchLoopResult;
  stale: StalePlan;
  sessions: Map<true | string, SudoWorkerSession>;
  preReads: PreReads;
}
