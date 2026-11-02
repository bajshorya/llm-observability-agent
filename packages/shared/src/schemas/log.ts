/**
 * The wire contract for log ingestion — the shape of everything entering the
 * system.
 *
 * WHAT THIS FILE DOES
 * Defines and exports the Zod schemas for a single log entry, a batch of them,
 * and the result of trying to ingest that batch. Every entry crossing the
 * ingestion boundary is validated against `logEntrySchema`; malformed entries
 * are rejected rather than stored, because the store is only ever as
 * trustworthy as what is let into it.
 *
 * WHAT IT EXPORTS
 *   - `logEntrySchema`      one entry: timestamp, service, level, message,
 *                           metadata. The type `LogEntry` is inferred from it.
 *   - `logMetadataSchema`   known fields typed, anything else allowed through.
 *   - `ingestBatchSchema`   an array of entries, capped at MAX_BATCH_SIZE.
 *   - `ingestResultSchema`  accepted / rejected counts plus per-index reasons.
 *   - `LOG_LEVELS`, `ERROR_LEVELS`, `SIGNATURE_LEVELS` and their predicates.
 *
 * THE THREE LEVEL SETS, WHICH ARE DELIBERATELY DIFFERENT
 *   `LOG_LEVELS`       every level that exists: info, warn, error, fatal.
 *   `ERROR_LEVELS`     what counts towards the error-rate detector: error,
 *                      fatal. A 404 or a 429 is not a failure of the service.
 *   `SIGNATURE_LEVELS` what gets an error signature computed: warn, error,
 *                      fatal — wider on purpose. A 429 is not an error, but a
 *                      *new kind* of 4xx appearing is still a regression worth
 *                      catching, and restricting signatures to error level
 *                      would blind the new-signature detector to it.
 *
 * DESIGN NOTES
 * The timestamp accepts an ISO-8601 string or epoch milliseconds, with a custom
 * error message: this is what an engineer integrating a new service sees when
 * they get it wrong, and Zod's default ("expected date, received Date")
 * explains nothing.
 *
 * Metadata is `.catchall(z.unknown())` so a monitored app can attach its own
 * context without this schema needing a redeploy. Known fields are still
 * typed, so the rollup worker and the evidence builder can rely on them.
 *
 * Ingestion is partial-success by design, which is why `ingestResultSchema`
 * carries per-index rejection reasons rather than a single boolean.
 */

import { z } from "zod";

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

/**
 * Anything before this is a unit mistake, not a log line: epoch SECONDS read as
 * milliseconds land in January 1970. Rejected with a message that says so,
 * rather than stored as a line from fifty years ago.
 *
 * The matching upper bound (no more than a few minutes in the future) needs a
 * clock, so it lives in the ingest route, not in this pure schema.
 */
export const MIN_LOG_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");

/**
 * Service names appear in URLs, prompts, alerts and file-like contexts, so
 * they are identifiers, not free text: letters, digits, dot, dash and
 * underscore, starting with a letter or digit. Every Kubernetes, ECS and
 * systemd service name already fits.
 */
export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Serialised metadata per entry. Generous for context, bounded for storage. */
export const MAX_METADATA_BYTES = 16_384;

export const logEntrySchema = z.object({
  /**
   * Accepts an ISO-8601 string or epoch milliseconds. The custom error text
   * matters: this is the message an engineer integrating a new service sees,
   * and Zod's default ("expected date, received Date") explains nothing.
   */
  timestamp: z.coerce
    .date({
      error: "must be an ISO-8601 string or epoch milliseconds",
    })
    .min(MIN_LOG_TIMESTAMP, {
      error: "is before 2000 — epoch seconds sent where milliseconds were expected?",
    }),
  service: z
    .string()
    .min(1)
    .max(64)
    .regex(SERVICE_NAME_PATTERN, {
      error: "must be letters, digits, '.', '-' or '_', starting with a letter or digit",
    }),
  level: logLevelSchema,
  message: z.string().min(1).max(4096),
  metadata: logMetadataSchema.default({}).refine(
    (metadata) => JSON.stringify(metadata).length <= MAX_METADATA_BYTES,
    { error: `must serialise to at most ${MAX_METADATA_BYTES} bytes` },
  ),
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
