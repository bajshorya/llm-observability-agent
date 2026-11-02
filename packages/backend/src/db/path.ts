/**
 * Where the database lives — no side effects.
 *
 * Split out of `client.ts` because importing that file opens a read-write
 * connection and migrates the schema. The dashboard needs the same path
 * without either, so it can open its own READ-ONLY connection.
 *
 * `DATABASE_URL` may be `file:./data/dev.db` or an absolute path. The `file:`
 * prefix is stripped and relative paths resolve against the repo root, not
 * against `process.cwd()`, so every command finds the same file wherever it is
 * run from.
 */

import { isAbsolute, resolve } from "node:path";
import { env, REPO_ROOT } from "../env";

export function resolveDatabasePath(url: string): string {
  const raw = url.replace(/^file:/, "");
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export const databasePath = resolveDatabasePath(env.DATABASE_URL);
