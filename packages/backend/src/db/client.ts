/**
 * The database connection — one SQLite handle, shared by everything.
 *
 * WHAT THIS FILE DOES
 * Resolves the database path, creates the directory if needed, opens a
 * better-sqlite3 connection, sets two pragmas, and exports a Drizzle instance
 * bound to the schema. Every query in the backend goes through the `db` it
 * exports.
 *
 * PATH RESOLUTION
 * `DATABASE_URL` may be `file:./data/dev.db` or an absolute path. The `file:`
 * prefix is stripped and relative paths are resolved against `REPO_ROOT` — not
 * against `process.cwd()` — so the database is the same file whether a command
 * is run from the workspace root or from inside a package.
 *
 * THE TWO PRAGMAS
 *   journal_mode = WAL   Write-ahead logging lets the ingestion endpoint keep
 *                        writing while detection queries read. Without it,
 *                        SQLite's default locking would make `pnpm detect`
 *                        and a live generator contend for the file.
 *   foreign_keys = ON    SQLite does not enforce foreign keys unless asked.
 *                        The cascade deletes on `correlations`, `hypotheses`
 *                        and `llm_calls` are silently inert without this.
 *
 * MODULE-LEVEL SIDE EFFECT — worth knowing
 * Importing this file OPENS THE DATABASE. That is why the pure modules
 * (`detectors.ts`, `context.ts`, `structured.ts`, `grounding.ts`) deliberately
 * do not import it, and why the unit tests can run with no database present.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env, REPO_ROOT } from "../env";
import * as schema from "./schema";

/** `file:./data/dev.db` -> absolute path, resolved against the repo root. */
function resolveDatabasePath(url: string): string {
  const raw = url.replace(/^file:/, "");
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

const databasePath = resolveDatabasePath(env.DATABASE_URL);
mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath);
// WAL lets the ingestion endpoint keep writing while detection queries read.
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { databasePath, schema };
