/**
 * The database connection — one SQLite handle, shared by everything.
 *
 * WHAT THIS FILE DOES
 * Creates the directory if needed, opens a better-sqlite3 connection, sets its
 * pragmas, applies pending migrations (`migrate.ts`), checks the result against
 * `schema.ts`, and exports a Drizzle instance bound to the schema. Every query
 * in the backend goes through the `db` it exports. Path resolution is in
 * `path.ts`.
 *
 * A fresh `DATABASE_URL` therefore just works: the first process to open it
 * builds the schema. A database that is missing columns fails HERE, naming
 * them, instead of at the first query that touches one.
 *
 * THE PRAGMAS
 *   journal_mode = WAL   Write-ahead logging lets the ingestion endpoint keep
 *                        writing while detection queries read. Without it,
 *                        SQLite's default locking would make `pnpm detect`
 *                        and a live generator contend for the file.
 *   foreign_keys = ON    SQLite does not enforce foreign keys unless asked.
 *                        The cascade deletes on `correlations`, `hypotheses`
 *                        and `llm_calls` are silently inert without this.
 *   busy_timeout = 5000  The backend, `pnpm watch` and the CLIs are separate
 *                        processes writing one file. A writer that finds the
 *                        lock held waits up to five seconds instead of failing
 *                        at once with SQLITE_BUSY. (better-sqlite3's default
 *                        is the same; it is set explicitly so it is visible.)
 *
 * MODULE-LEVEL SIDE EFFECT — worth knowing
 * Importing this file OPENS THE DATABASE. That is why the pure modules
 * (`detectors.ts`, `context.ts`, `structured.ts`, `grounding.ts`) deliberately
 * do not import it, and why the unit tests can run with no database present.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { databasePath } from "./path";
import { migrate, missingColumns } from "./migrate";
import * as schema from "./schema";

mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath);
// WAL lets the ingestion endpoint keep writing while detection queries read.
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

migrate(sqlite);

const missing = missingColumns(sqlite, [
  schema.logs,
  schema.metricsRollup,
  schema.anomalies,
  schema.correlations,
  schema.hypotheses,
  schema.llmCalls,
  schema.alerts,
]);
if (missing.length > 0) {
  throw new Error(
    `The database at ${databasePath} is missing columns the code expects: ${missing.join(", ")}. ` +
      "Add a migration in src/db/migrate.ts, or run `pnpm db:push` for data/dev.db.",
  );
}

export const db = drizzle(sqlite, { schema });
export { databasePath, schema };
