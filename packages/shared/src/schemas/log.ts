import { z } from "zod";

/**
 * The wire contract for a single structured log entry.
 *
 * Every entry crossing the ingestion boundary is validated against this.
 * Malformed entries are rejected rather than stored — the store is only ever
 * as trustworthy as what we let into it.
 */

export const LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevelSchema = z.enum(LOG_LEVELS);

/** Levels that count towards the error-rate spike detector. */
export const ERROR_LEVELS: readonly LogLevel[] = ["error", "fatal"];

export function isErrorLevel(level: LogLevel): boolean {
  return ERROR_LEVELS.includes(level);
}

/**
 * Levels we compute an error signature for.
 *
 * Deliberately wider than ERROR_LEVELS: a 404 or 429 is a warning rather than
 * an error, but a *new kind* of 4xx appearing is still a signal worth
 * catching. Restricting signatures to error-level entries would leave the
 * new-signature detector blind to a whole class of regressions.
 */
export const SIGNATURE_LEVELS: readonly LogLevel[] = ["warn", "error", "fatal"];

export function hasErrorSignature(level: LogLevel): boolean {
  return SIGNATURE_LEVELS.includes(level);
}

/**
 * Known metadata fields are typed; anything else is allowed through.
 * A monitored app should be able to attach its own context without us
 * having to redeploy the schema.
 */
export const logMetadataSchema = z
  .object({
    requestId: z.string().max(128).optional(),
    endpoint: z.string().max(256).optional(),
    method: z.string().max(16).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().nonnegative().max(600_000).optional(),
    errorType: z.string().max(128).optional(),
    stack: z.string().max(8192).optional(),
  })
  .catchall(z.unknown());

export type LogMetadata = z.infer<typeof logMetadataSchema>;

export const logEntrySchema = z.object({
  /**
   * Accepts an ISO-8601 string or epoch milliseconds. The custom error text
   * matters: this is the message an engineer integrating a new service sees,
   * and Zod's default ("expected date, received Date") explains nothing.
   */
  timestamp: z.coerce.date({
    error: "must be an ISO-8601 string or epoch milliseconds",
  }),
  service: z.string().min(1).max(64),
  level: logLevelSchema,
  message: z.string().min(1).max(4096),
  metadata: logMetadataSchema.default({}),
});

export type LogEntry = z.infer<typeof logEntrySchema>;
/** Shape callers send before Zod coercion fills in defaults. */
export type LogEntryInput = z.input<typeof logEntrySchema>;

/** Batches are capped so a single request can't blow up memory. */
export const MAX_BATCH_SIZE = 1000;

export const ingestBatchSchema = z.object({
  entries: z.array(logEntrySchema).min(1).max(MAX_BATCH_SIZE),
});

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/**
 * Ingestion is partial-success by design: one bad entry in a batch of 500
 * should not discard the other 499. We report what was rejected instead.
 */
export const ingestResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  errors: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    )
    .max(20),
});

export type IngestResult = z.infer<typeof ingestResultSchema>;
