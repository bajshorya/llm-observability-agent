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
