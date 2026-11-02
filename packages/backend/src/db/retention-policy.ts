/**
 * Retention cutoffs — pure. Split from `retention.ts`, which opens the
 * database on import, so the arithmetic can be tested with no database.
 * The policy itself is explained in `retention.ts`.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Days of raw logs to keep. 0 keeps everything. */
  logDays: number;
  /** Days of per-minute rollups to keep. 0 keeps everything. */
  rollupDays: number;
}

export interface RetentionCutoffs {
  logsBefore: Date | null;
  rollupsBefore: Date | null;
}

/** Pure. Rows strictly older than each cutoff are deleted; null keeps everything. */
export function retentionCutoffs(now: Date, policy: RetentionPolicy): RetentionCutoffs {
  const cutoff = (days: number): Date | null => {
    if (!Number.isFinite(days) || days < 0) throw new Error(`retention must be 0 or a positive number of days, got ${days}`);
    if (days === 0) return null;
    if (days < 1) throw new Error(`retention under one day would delete detection's baseline, got ${days}`);
    return new Date(now.getTime() - days * DAY_MS);
  };
  return { logsBefore: cutoff(policy.logDays), rollupsBefore: cutoff(policy.rollupDays) };
}

