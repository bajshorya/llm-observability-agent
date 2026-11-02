/**
 * Which minutes the rollup must recompute for late logs. Pure: no database, no clock.
 *
 * THE FAILURE THIS FIXES
 * The rollup used to resume from the newest bucket it had written, by
 * timestamp. Anything that arrived with an OLDER timestamp was never
 * aggregated. That covers @obs/client flushing its buffer after a network
 * blip, a collector delivering late, and a new service onboarded with an hour
 * of history after another service had already been rolled up. The last case
 * was found in a live run: 120 minutes of a new service's backfill, every line
 * accepted and stored, and detection reported "only 0 min of baseline" and
 * skipped the service entirely. It was unmonitored, and nothing said so.
 *
 * THE FIX
 * Ingest order, not event time, decides what is new: the rollup remembers the
 * highest log rowid it has accounted for (`rollup_state`). Every run reads the
 * distinct (service, minute) pairs of the rows ingested since, and recomputes
 * each of those minutes from ALL of its logs. That is idempotent, because
 * buckets are upserts. This file turns those pairs into contiguous runs, so a
 * two-hour backfill is one range query and not 120.
 */

export const MINUTE_MS = 60_000;

export interface DirtyMinute {
  service: string;
  /** Start of the minute, epoch ms. */
  minute: number;
}

export interface DirtyRun {
  service: string;
  /** Inclusive, epoch ms. */
  start: number;
  /** Exclusive, epoch ms. */
  end: number;
}

/**
 * Coalesce dirty minutes into per-service runs of consecutive minutes,
 * keeping only closed minutes before `before`. That is the bound where the
 * time-based tail starts (it recomputes everything from there for every
 * service), so a minute is never counted twice.
 */
export function planLateRuns(minutes: readonly DirtyMinute[], before: number): DirtyRun[] {
  const byService = new Map<string, number[]>();
  for (const { service, minute } of minutes) {
    if (minute >= before) continue;
    const list = byService.get(service) ?? [];
    list.push(minute);
    byService.set(service, list);
  }

  const runs: DirtyRun[] = [];
  for (const [service, list] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    let start = sorted[0]!;
    let end = start + MINUTE_MS;
    for (const minute of sorted.slice(1)) {
      if (minute === end) {
        end += MINUTE_MS;
      } else {
        runs.push({ service, start, end });
        start = minute;
        end = minute + MINUTE_MS;
      }
    }
    runs.push({ service, start, end });
  }
  return runs;
}

/**
 * Where to resume from. A stored watermark above the table's highest rowid
 * means rowids were reused (SQLite does this after the newest rows are
 * deleted, e.g. an emptied table), so the stored value no longer marks
 * anything and the scan restarts from the beginning.
 */
export function resumeRowid(stored: number | null, maxRowid: number): number {
  if (stored === null || stored > maxRowid) return 0;
  return stored;
}
