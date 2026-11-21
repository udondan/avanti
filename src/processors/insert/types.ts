/** What history knows about the previous insert into a file. */
export interface InsertHistory {
  /** The processed fragment that was inserted. */
  processed: string;
  /** What the insert added, when the format tracks it (INI). */
  owned?: unknown;
}

export interface InsertResult {
  text: string;
  /** What this insert added; store it in history for the next insert. */
  owned?: unknown;
}
