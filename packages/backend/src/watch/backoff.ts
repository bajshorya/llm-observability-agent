/**
 * Per-anomaly backoff for `pnpm watch` — pure, counted in ticks, no clock.
 *
 * WHY IT EXISTS
 * Every stage takes the OLDEST pending anomaly first. One that fails every time
 * — a repository that cannot be read, a packet a model cannot answer — used to
 * be retried on every tick and, because the stage stops on its first failure,
 * held up every anomaly queued behind it. One bad row could starve a stage
 * indefinitely.
 *
 * A failing anomaly is now passed over for 1, 2, 4, 8 … ticks (capped at
 * `MAX_BACKOFF_TICKS`, an hour at the default 30s interval), and the stage
 * moves on to the rows behind it. A success clears it.
 *
 * WHY IN MEMORY
 * A restart forgets the backoff and retries everything once. That is the right
 * default for the most common cause — a quota that has since reset, or a
 * config fixed before restarting — and it needs no schema change. The daily
 * budget, which IS persisted, still bounds what retries can spend.
 */

export interface BackoffEntry {
  failures: number;
  /** The first tick on which this anomaly may be tried again. */
  retryAtTick: number;
  lastError: string;
}

export const MAX_BACKOFF_TICKS = 120;

export function recordFailure(
  previous: BackoffEntry | undefined,
  tick: number,
  error: string,
): BackoffEntry {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = Math.min(2 ** (failures - 1), MAX_BACKOFF_TICKS);
  return { failures, retryAtTick: tick + delay, lastError: error };
}

/** Ids still inside their backoff on `tick`. */
export function backedOffIds(entries: ReadonlyMap<string, BackoffEntry>, tick: number): string[] {
  const ids: string[] = [];
  for (const [id, entry] of entries) {
    if (entry.retryAtTick > tick) ids.push(id);
  }
  return ids;
}

/** Print a failure the first time it appears and whenever its message changes — not every tick. */
export function isNewFailure(previous: BackoffEntry | undefined, error: string): boolean {
  return previous === undefined || previous.lastError !== error;
}
