/**
 * The entire data model — all six tables, in one file.
 *
 * WHAT THIS FILE DOES
 * Defines every table with Drizzle, along with its indexes and the TypeScript
 * types inferred from them. Nothing else in the codebase declares storage; if a
 * column exists, it is here.
 *
 * THE SIX TABLES AND HOW THEY RELATE
 *
 *   logs             Raw entries, one row per log line. The only table written
 *                    in the hot path. Indexed on (service, timestamp) because
 *                    every detection query is time-windowed, and on
 *                    (service, error_signature) so new-signature lookup is an
 *                    index hit rather than a scan.
 *
 *   metrics_rollup   Per-minute aggregates computed from logs by the rollup
 *                    worker. Detection reads these — sixty rows — instead of
 *                    hundreds of thousands of raw ones. The UNIQUE index on
 *                    (service, endpoint, bucket_start) is what makes the worker
 *                    idempotent: re-running it upserts rather than duplicates.
 *                    `endpoint = ""` is the sentinel for the service-wide row.
 *
 *   anomalies        Tier 1 writes window + triggers and leaves severity,
 *                    summary and is_real_incident NULL. Tier 2 fills them.
 *                    Those NULLs are the handoff contract between the tiers —
 *                    "unclassified" is `severity IS NULL`, not a status value,
 *                    so an anomaly is never classified twice however its status
 *                    later moves.
 *
 *   correlations     Phase 3. Suspected commit, confidence, reasoning.
 *   hypotheses       Phase 4. Root cause and suggested fix. `applied` defaults
 *                    to false and stays there — the agent diagnoses, a human
 *                    decides. That gate is deliberate.
 *   llm_calls        One row per model invocation: tokens, latency, repair
 *                    attempts, success. Failures included, because a call that
 *                    burned tokens and produced nothing still cost quota. This
 *                    table is what substantiates the two-tier cost claim.
 *
 * WHY SQLITE LOOKS LIKE POSTGRES HERE
 * Timestamps are stored as epoch milliseconds and JSON as text — SQLite's
 * equivalents of `timestamptz` and `jsonb`. The types are declared through
 * Drizzle's mode options (`{ mode: "timestamp_ms" }`, `{ mode: "json" }`), so
 * application code already works in `Date` and typed objects.
 *
 * Migrating to Postgres is therefore a change to the column builders in THIS
 * FILE and the driver in `client.ts`. No query and no application code changes.
 */

import { randomUUID } from "node:crypto";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AnomalyStatus,
  AnomalyTrigger,
  LogLevel,
  LogMetadata,
  Severity,
} from "@obs/shared";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const logs = sqliteTable(
  "logs",
  {
    id: id(),
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    service: text("service").notNull(),
    level: text("level").$type<LogLevel>().notNull(),
    message: text("message").notNull(),
    /**
     * Normalised error signature, computed once at ingest for error-level
     * entries only. Strictly this is a hair more than "validate and persist",
     * but it is a pure O(1) string transform, and precomputing it turns the
     * new-error-signature detector into an indexed lookup instead of a regex
     * pass over millions of rows at query time.
     */
    errorSignature: text("error_signature"),
    metadata: text("metadata", { mode: "json" }).$type<LogMetadata>().notNull(),
  },
  (t) => [
    // Every detection query is time-windowed per service.
    index("logs_service_timestamp_idx").on(t.service, t.timestamp),
    index("logs_signature_idx").on(t.service, t.errorSignature),
  ],
);

/**
 * Per-minute aggregates computed from raw logs by a background worker.
 * Detection reads these cheap rollups, never the raw log table.
 */
export const metricsRollup = sqliteTable(
  "metrics_rollup",
  {
    id: id(),
    bucketStart: integer("bucket_start", { mode: "timestamp_ms" }).notNull(),
    service: text("service").notNull(),
    endpoint: text("endpoint").notNull().default(""),
    requestCount: integer("request_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    p50Ms: integer("p50_ms").notNull().default(0),
    p95Ms: integer("p95_ms").notNull().default(0),
    p99Ms: integer("p99_ms").notNull().default(0),
  },
  (t) => [
    // One row per service/endpoint/minute — makes the worker idempotent.
    uniqueIndex("metrics_rollup_bucket_idx").on(t.service, t.endpoint, t.bucketStart),
  ],
);

export const anomalies = sqliteTable(
  "anomalies",
  {
    id: id(),
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    windowEnd: integer("window_end", { mode: "timestamp_ms" }).notNull(),
    service: text("service").notNull(),
    /** Which Tier 1 statistical signal(s) fired. */
    triggers: text("triggers", { mode: "json" }).$type<AnomalyTrigger[]>().notNull(),

    // --- Populated by Tier 2 (LLM classifier); null until then. ---
    severity: text("severity").$type<Severity>(),
    summary: text("summary"),
    isRealIncident: integer("is_real_incident", { mode: "boolean" }),
    /**
     * The endpoint, dependency or subsystem Tier 2 implicated, or "unknown"
     * when the evidence identified none.
     *
     * Added in Phase 3. The classifier had produced this field since Phase 2 —
     * the CLI printed it and the eval scored it — but nothing wrote it down,
     * so it existed only for the length of one process. Correlation is the
     * first consumer that needs it later than the call that produced it.
     */
    affectedArea: text("affected_area"),

    status: text("status").$type<AnomalyStatus>().notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("anomalies_window_idx").on(t.service, t.windowStart)],
);

export const correlations = sqliteTable(
  "correlations",
  {
    id: id(),
    anomalyId: text("anomaly_id")
      .notNull()
      .references(() => anomalies.id, { onDelete: "cascade" }),
    /** Null when no candidate commit plausibly explains the anomaly. */
    suspectedCommitSha: text("suspected_commit_sha"),
    confidence: real("confidence").notNull(),
    reasoning: text("reasoning").notNull(),
    implicatedFiles: text("implicated_files", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("correlations_anomaly_idx").on(t.anomalyId)],
);

export const hypotheses = sqliteTable(
  "hypotheses",
  {
    id: id(),
    anomalyId: text("anomaly_id")
      .notNull()
      .references(() => anomalies.id, { onDelete: "cascade" }),
    rootCause: text("root_cause").notNull(),
    suggestedFix: text("suggested_fix").notNull(),
    confidence: real("confidence").notNull(),
    /**
     * Stays false. The agent diagnoses; a human decides whether to act.
     * Any write action is gated behind explicit human confirmation.
     */
    applied: integer("applied", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("hypotheses_anomaly_idx").on(t.anomalyId)],
);

/**
 * One row per LLM invocation. This table is how we substantiate the central
 * claim of the two-tier design — that the model fires rarely and cheaply.
 */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: id(),
    anomalyId: text("anomaly_id").references(() => anomalies.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    agent: text("agent").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    repairAttempts: integer("repair_attempts").notNull().default(0),
    succeeded: integer("succeeded", { mode: "boolean" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_anomaly_idx").on(t.anomalyId)],
);

export type LogRow = typeof logs.$inferSelect;
export type NewLogRow = typeof logs.$inferInsert;
export type AnomalyRow = typeof anomalies.$inferSelect;
export type MetricsRollupRow = typeof metricsRollup.$inferSelect;
