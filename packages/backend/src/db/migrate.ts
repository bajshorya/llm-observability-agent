/**
 * Schema migrations, applied when the database is opened.
 *
 * WHY THIS EXISTS
 * The schema used to be created only by `pnpm db:push`, which is drizzle-kit
 * run outside the app and which always writes `data/dev.db`. Pointing
 * `DATABASE_URL` anywhere else — which is the first thing a deployment does —
 * produced a database with no tables, and every command died with
 * `no such table: metrics_rollup`. A system that cannot start on an empty disk
 * is not deployable, however good the rest of it is.
 *
 * HOW IT WORKS
 * Migrations are an ordered list in this file. SQLite's own `user_version`
 * pragma records how many have run, so there is no bookkeeping table. Pending
 * migrations run inside one `BEGIN IMMEDIATE` transaction, and the version is
 * re-read inside it, so two processes starting at once (the backend and
 * `pnpm watch`) cannot both apply the same migration: the second waits for the
 * write lock, then sees there is nothing left to do.
 *
 * WHY THE BASELINE SAYS "IF NOT EXISTS"
 * Every database made before this file existed was made by `db:push`, has the
 * same tables, and has `user_version = 0`. The baseline therefore has to be a
 * no-op on those and a full build on an empty file. Later migrations check
 * before they alter, for the same reason: `db:push` may already have applied
 * the change during development.
 *
 * DRIFT
 * `missingColumns` compares the live database with `schema.ts`. A column added
 * to the schema without a migration is caught by the test suite (which builds
 * a database from these migrations alone), and a database that is somehow
 * behind fails at open with the list of what is missing, rather than with a
 * SQL error three layers down at the first query that touches it.
 *
 * `pnpm db:push` still works and is still convenient during development. It is
 * no longer required.
 */

import type Database from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";

export interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.pragma(`table_info(${table})`) as { name: string }[];
  return columns.some((c) => c.name === column);
}

const BASELINE = `
CREATE TABLE IF NOT EXISTS logs (
  id text PRIMARY KEY NOT NULL,
  timestamp integer NOT NULL,
  service text NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  error_signature text,
  metadata text NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_service_timestamp_idx ON logs (service, timestamp);
CREATE INDEX IF NOT EXISTS logs_signature_idx ON logs (service, error_signature);

CREATE TABLE IF NOT EXISTS metrics_rollup (
  id text PRIMARY KEY NOT NULL,
  bucket_start integer NOT NULL,
  service text NOT NULL,
  endpoint text DEFAULT '' NOT NULL,
  request_count integer DEFAULT 0 NOT NULL,
  error_count integer DEFAULT 0 NOT NULL,
  p50_ms integer DEFAULT 0 NOT NULL,
  p95_ms integer DEFAULT 0 NOT NULL,
  p99_ms integer DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS metrics_rollup_bucket_idx ON metrics_rollup (service, endpoint, bucket_start);

CREATE TABLE IF NOT EXISTS anomalies (
  id text PRIMARY KEY NOT NULL,
  detected_at integer NOT NULL,
  window_start integer NOT NULL,
  window_end integer NOT NULL,
  service text NOT NULL,
  triggers text NOT NULL,
  severity text,
  summary text,
  is_real_incident integer,
  affected_area text,
  status text DEFAULT 'open' NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS anomalies_window_idx ON anomalies (service, window_start);

CREATE TABLE IF NOT EXISTS correlations (
  id text PRIMARY KEY NOT NULL,
  anomaly_id text NOT NULL REFERENCES anomalies(id) ON DELETE CASCADE,
  suspected_commit_sha text,
  confidence real NOT NULL,
  reasoning text NOT NULL,
  implicated_files text NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS correlations_anomaly_idx ON correlations (anomaly_id);

CREATE TABLE IF NOT EXISTS hypotheses (
  id text PRIMARY KEY NOT NULL,
  anomaly_id text NOT NULL REFERENCES anomalies(id) ON DELETE CASCADE,
  root_cause text NOT NULL,
  suggested_fix text NOT NULL,
  confidence real NOT NULL,
  applied integer DEFAULT false NOT NULL,
  created_at integer NOT NULL,
  explains_the_failure integer DEFAULT true NOT NULL
);
CREATE INDEX IF NOT EXISTS hypotheses_anomaly_idx ON hypotheses (anomaly_id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id text PRIMARY KEY NOT NULL,
  anomaly_id text REFERENCES anomalies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  agent text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer NOT NULL,
  repair_attempts integer DEFAULT 0 NOT NULL,
  succeeded integer NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_calls_anomaly_idx ON llm_calls (anomaly_id);

CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY NOT NULL,
  anomaly_id text NOT NULL REFERENCES anomalies(id) ON DELETE CASCADE,
  reason text NOT NULL,
  channel text NOT NULL,
  succeeded integer NOT NULL,
  error text,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_anomaly_idx ON alerts (anomaly_id);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "baseline",
    up(sqlite) {
      sqlite.exec(BASELINE);
      // Databases pushed before Phase 4's pairing work lack this column.
      if (!hasColumn(sqlite, "hypotheses", "explains_the_failure")) {
        sqlite.exec("ALTER TABLE hypotheses ADD COLUMN explains_the_failure integer DEFAULT true NOT NULL");
      }
    },
  },
];

export const LATEST_VERSION = migrations.at(-1)?.version ?? 0;

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function migrate(sqlite: Database.Database, list: readonly Migration[] = migrations): MigrationResult {
  const before = sqlite.pragma("user_version", { simple: true }) as number;
  const latest = list.at(-1)?.version ?? 0;
  if (before >= latest) return { from: before, to: before, applied: [] };

  const applied: string[] = [];
  const run = sqlite.transaction(() => {
    // Re-read under the write lock: another process may have just finished.
    const current = sqlite.pragma("user_version", { simple: true }) as number;
    for (const migration of list) {
      if (migration.version <= current) continue;
      migration.up(sqlite);
      sqlite.pragma(`user_version = ${migration.version}`);
      applied.push(`${migration.version}_${migration.name}`);
    }
  });
  run.immediate();

  return { from: before, to: sqlite.pragma("user_version", { simple: true }) as number, applied };
}

/** `table.column` for every column `schema.ts` declares that the database lacks. */
export function missingColumns(sqlite: Database.Database, tables: readonly SQLiteTable[]): string[] {
  const missing: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const present = new Set(
      (sqlite.pragma(`table_info(${config.name})`) as { name: string }[]).map((c) => c.name),
    );
    for (const column of config.columns) {
      if (!present.has(column.name)) missing.push(`${config.name}.${column.name}`);
    }
  }
  return missing;
}
