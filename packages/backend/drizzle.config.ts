/**
 * Drizzle Kit configuration — schema tooling only.
 *
 * WHAT THIS FILE DOES
 * Tells `drizzle-kit` where the schema lives and which database to apply it to.
 * It powers exactly two commands:
 *
 *   pnpm db:push     create or update tables from `src/db/schema.ts`
 *   pnpm db:studio   open a browser UI over the database
 *
 * WHAT IT DOES NOT DO
 * This is not the runtime connection — that is `src/db/client.ts`, which reads
 * `DATABASE_URL` from the environment. The path below is hardcoded because
 * drizzle-kit runs as a standalone CLI outside the app's env loading, and
 * because schema pushes should always target the development database rather
 * than wherever `DATABASE_URL` happens to point.
 *
 * The consequence worth knowing: `pnpm db:push` always writes to
 * `data/dev.db`, regardless of `DATABASE_URL`. Scratch databases used by
 * `scripts/capture-cases.sh` are created by copying that file's schema instead.
 */

import { defineConfig } from "drizzle-kit";

// Paths are relative to this package; the database lives at the repo root so
// a demo reset is a single `rm data/dev.db`.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "../../data/dev.db",
  },
});
