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
