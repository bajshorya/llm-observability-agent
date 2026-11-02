/**
 * The dashboard's database handle — opened READ-ONLY.
 *
 * The dashboard must never write: no button classifies, correlates or re-runs
 * anything (CLAUDE.md). Until this file it shared the backend's read-write
 * connection, so that rule was a convention. Opened `readonly`, SQLite itself
 * refuses any write, so a future page that tried would fail loudly in
 * development rather than quietly spending quota or changing state.
 *
 * It also means the dashboard never migrates the schema: the backend, `pnpm
 * watch` and every CLI do that when they open the file. `fileMustExist` turns
 * "no database yet" into one clear message instead of an empty file that
 * would then have no tables.
 *
 * One connection per server process, kept on globalThis so Next's dev-mode
 * module reloading does not open a new handle on every edit.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { databasePath } from "@obs/backend/src/db/path";
import * as schema from "@obs/backend/src/db/schema";

type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as { obsDashboardDb?: Db };

function open(): Db {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(
      `No database at ${databasePath}. Start the backend (\`pnpm backend\`) or run any pnpm command ` +
        "once to create it, or point DATABASE_URL at an existing one.",
      { cause: error },
    );
  }
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export const db: Db = globalForDb.obsDashboardDb ?? (globalForDb.obsDashboardDb = open());
