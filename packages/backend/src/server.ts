/**
 * The HTTP server — the only long-running process in the system.
 *
 * WHAT THIS FILE DOES
 * Builds the Fastify app, registers the two routes, starts listening, and
 * handles shutdown signals. It is intentionally thin: the ingestion logic lives
 * in `routes/ingest.ts`, and everything else in the backend is a CLI rather
 * than an endpoint.
 *
 * THE TWO ROUTES
 *   GET  /health   status, the resolved database path, and the current log
 *                  count. The log count is the useful part — it answers "is the
 *                  generator actually reaching this server" in one call.
 *   POST /ingest   registered from `routes/ingest.ts`.
 *
 * WHY DETECTION IS NOT AN ENDPOINT
 * Detection and classification are commands (`pnpm detect`, `pnpm classify`),
 * not routes. They are idempotent, they run on a schedule rather than on
 * request, and keeping them out of the server means the process that sits in
 * every monitored service's hot path does nothing but validate and persist.
 *
 * TWO CONFIGURATION DETAILS
 *   bodyLimit is raised to 16 MB. Log batches are large and Fastify's 1 MB
 *   default rejects a full 500-entry chunk.
 *
 *   The logger options are built CONDITIONALLY rather than with
 *   `transport: undefined`. Under `exactOptionalPropertyTypes` an explicit
 *   undefined is not the same as an absent key, and Fastify's types correctly
 *   reject it — so the ternary is load-bearing, not stylistic.
 *
 * SHUTDOWN
 * SIGINT and SIGTERM close the app before exiting, so an in-flight batch is not
 * truncated mid-insert.
 */

import Fastify from "fastify";
import { count } from "drizzle-orm";
import { databasePath, db } from "./db/client";
import { logs } from "./db/schema";
import { env } from "./env";
import { registerIngestRoute } from "./routes/ingest";

/**
 * Built conditionally rather than with `transport: undefined` — under
 * `exactOptionalPropertyTypes` an explicit undefined is not the same as
 * an absent key, and Fastify's types (correctly) reject it.
 */
const loggerOptions =
  env.NODE_ENV === "development"
    ? {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level: env.NODE_ENV === "production" ? "info" : "warn" };

const app = Fastify({
  logger: loggerOptions,
  // Log batches are large; the 1 MB default is not enough.
  bodyLimit: 16 * 1024 * 1024,
});

app.get("/health", async () => {
  const [row] = await db.select({ value: count() }).from(logs);
  return {
    status: "ok",
    database: databasePath,
    logCount: row?.value ?? 0,
  };
});

registerIngestRoute(app);

async function start(): Promise<void> {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`ingesting into ${databasePath}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

void start();
