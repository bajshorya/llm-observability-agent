/**
 * Retention — deleting what is too old to matter.
 *
 * WHY
 * Nothing deleted anything. `logs` grows by one row per request, forever, and
 * on a busy service SQLite's file grows until the disk is full — at which
 * point ingest fails, and the system meant to notice outages becomes one. A
 * monitoring store needs a retention policy the way a log file needs rotation.
 *
 * WHAT IS KEPT, AND FOR HOW LONG
 *
 *   logs            LOG_RETENTION_DAYS, default 14. The raw lines are the
 *                   bulk of the database, and the pipeline reads at most the
 *                   last few hours: detection's baseline is an hour, silence
 *                   looks back three.
 *   metrics_rollup  ROLLUP_RETENTION_DAYS, default 90. One row per endpoint
 *                   per minute — small — and what the dashboard's charts and
 *                   any long-range comparison are drawn from.
 *   everything else anomalies, verdicts, correlations, hypotheses, model calls
 *                   and alerts are never deleted. They are the record of what
 *                   the system concluded and what it cost, they are tiny, and
 *                   deleting them would rewrite the history the evals and the
 *                   cost page argue from.
 *
 * 0 means keep forever. Anything else is at least one day, because a shorter
 * retention would delete the baseline detection compares against.
 *
 * THE COST, STATED
 * An anomaly older than the log retention keeps its verdict, summary and
 * reasoning, but its evidence packet can no longer be rebuilt — the dashboard
 * shows the conclusions without the raw lines behind them.
 *
 * HOW IT DELETES
 * In batches of `batchSize` rows, per service, along the (service, timestamp)
 * index, each batch its own short transaction. One `DELETE` of a month of logs
 * would hold SQLite's single write lock for as long as it took, and ingest
 * would wait behind it. Space freed is reused by SQLite for new rows; the file
 * does not shrink without a VACUUM, which is deliberately not run
 * automatically — it rewrites the whole file and locks it while it does.
 */

import { and, lt, sql, eq } from "drizzle-orm";
import { db } from "./client";
import { logs, metricsRollup } from "./schema";

import { retentionCutoffs, type RetentionCutoffs, type RetentionPolicy } from "./retention-policy";

export { retentionCutoffs, type RetentionCutoffs, type RetentionPolicy };

export interface PruneResult {
  cutoffs: RetentionCutoffs;
  logsDeleted: number;
  rollupsDeleted: number;
  dryRun: boolean;
}

export interface PruneOptions {
  now?: Date;
  policy: RetentionPolicy;
  /** Count what would go, delete nothing. */
  dryRun?: boolean;
  batchSize?: number;
}

async function services(): Promise<string[]> {
  const rows = await db.selectDistinct({ service: logs.service }).from(logs);
  const rollupRows = await db.selectDistinct({ service: metricsRollup.service }).from(metricsRollup);
  return [...new Set([...rows, ...rollupRows].map((row) => row.service))];
}

export async function pruneOldData(options: PruneOptions): Promise<PruneResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 5_000;
  const cutoffs = retentionCutoffs(now, options.policy);
  const result: PruneResult = { cutoffs, logsDeleted: 0, rollupsDeleted: 0, dryRun: options.dryRun ?? false };

  if (cutoffs.logsBefore === null && cutoffs.rollupsBefore === null) return result;

  for (const service of await services()) {
    if (cutoffs.logsBefore) {
      const where = and(eq(logs.service, service), lt(logs.timestamp, cutoffs.logsBefore));
      if (result.dryRun) {
        const [row] = await db.select({ n: sql<number>`count(*)` }).from(logs).where(where);
        result.logsDeleted += row?.n ?? 0;
      } else {
        for (;;) {
          const deleted = await db.run(
            sql`DELETE FROM ${logs} WHERE rowid IN (SELECT rowid FROM ${logs} WHERE ${where} LIMIT ${batchSize})`,
          );
          result.logsDeleted += deleted.changes;
          if (deleted.changes < batchSize) break;
        }
      }
    }

    if (cutoffs.rollupsBefore) {
      const where = and(eq(metricsRollup.service, service), lt(metricsRollup.bucketStart, cutoffs.rollupsBefore));
      if (result.dryRun) {
        const [row] = await db.select({ n: sql<number>`count(*)` }).from(metricsRollup).where(where);
        result.rollupsDeleted += row?.n ?? 0;
      } else {
        for (;;) {
          const deleted = await db.run(
            sql`DELETE FROM ${metricsRollup} WHERE rowid IN (SELECT rowid FROM ${metricsRollup} WHERE ${where} LIMIT ${batchSize})`,
          );
          result.rollupsDeleted += deleted.changes;
          if (deleted.changes < batchSize) break;
        }
      }
    }
  }

  return result;
}
