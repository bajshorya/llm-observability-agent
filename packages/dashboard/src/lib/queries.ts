/**
 * Everything the dashboard reads, in one file.
 *
 * WHAT THIS FILE DOES
 * Server-side queries against the same SQLite database the CLIs write. It
 * imports `@obs/backend`'s Drizzle schema and client rather than restating
 * either — a dashboard with its own idea of what a column means is a dashboard
 * that will eventually disagree with the pipeline and be believed.
 *
 * WHY IT READS THE DATABASE AND NOT AN HTTP API
 * The backend exposes exactly one route, `POST /ingest`, and everything else is
 * a CLI. Adding read endpoints only for the dashboard would mean a second place
 * where "what is an anomaly" is defined, for no gain: this runs on the same
 * machine, against the same file, in a server component. If the dashboard ever
 * needs to run somewhere else, that is when the API earns its keep.
 *
 * WHY EVERY FUNCTION IS READ-ONLY
 * The dashboard shows what the pipeline concluded. It does not classify,
 * correlate, dismiss or re-run anything. That is not a limitation to fix later
 * — `pnpm detect`, `pnpm classify` and `pnpm correlate` are separate commands
 * precisely because each one spends something, and a button that quietly spends
 * quota is how a free tier gets exhausted by a page refresh.
 */

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@obs/backend/src/db/client";
import { anomalies, correlations, hypotheses, llmCalls, logs } from "@obs/backend/src/db/schema";
import type { AnomalyStatus, AnomalyTrigger, Severity } from "@obs/shared";

export interface AnomalyRow {
  id: string;
  service: string;
  detectedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  triggers: AnomalyTrigger[];
  severity: Severity | null;
  summary: string | null;
  isRealIncident: boolean | null;
  affectedArea: string | null;
  status: AnomalyStatus;
}

export interface CorrelationRow {
  suspectedCommitSha: string | null;
  confidence: number;
  reasoning: string;
  implicatedFiles: string[];
  createdAt: Date;
}

export interface HypothesisRow {
  explainsTheFailure: boolean;
  rootCause: string;
  suggestedFix: string;
  confidence: number;
  /** Always false. The agent diagnoses; a human decides. */
  applied: boolean;
  createdAt: Date;
}

export interface LlmCallRow {
  agent: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  repairAttempts: number;
  succeeded: boolean;
  createdAt: Date;
}

const ANOMALY_COLUMNS = {
  id: anomalies.id,
  service: anomalies.service,
  detectedAt: anomalies.detectedAt,
  windowStart: anomalies.windowStart,
  windowEnd: anomalies.windowEnd,
  triggers: anomalies.triggers,
  severity: anomalies.severity,
  summary: anomalies.summary,
  isRealIncident: anomalies.isRealIncident,
  affectedArea: anomalies.affectedArea,
  status: anomalies.status,
};

/** Newest first — an on-call view is always "what just happened". */
export async function listAnomalies(limit = 100): Promise<AnomalyRow[]> {
  return db
    .select(ANOMALY_COLUMNS)
    .from(anomalies)
    .orderBy(desc(anomalies.detectedAt))
    .limit(limit) as Promise<AnomalyRow[]>;
}

export async function getAnomaly(id: string): Promise<AnomalyRow | null> {
  const [row] = await db.select(ANOMALY_COLUMNS).from(anomalies).where(eq(anomalies.id, id));
  return (row as AnomalyRow | undefined) ?? null;
}

export async function getCorrelation(anomalyId: string): Promise<CorrelationRow | null> {
  const [row] = await db
    .select({
      suspectedCommitSha: correlations.suspectedCommitSha,
      confidence: correlations.confidence,
      reasoning: correlations.reasoning,
      implicatedFiles: correlations.implicatedFiles,
      createdAt: correlations.createdAt,
    })
    .from(correlations)
    .where(eq(correlations.anomalyId, anomalyId))
    .orderBy(desc(correlations.createdAt))
    .limit(1);

  return (row as CorrelationRow | undefined) ?? null;
}

export async function getHypothesis(anomalyId: string): Promise<HypothesisRow | null> {
  const [row] = await db
    .select({
      explainsTheFailure: hypotheses.explainsTheFailure,
      rootCause: hypotheses.rootCause,
      suggestedFix: hypotheses.suggestedFix,
      confidence: hypotheses.confidence,
      applied: hypotheses.applied,
      createdAt: hypotheses.createdAt,
    })
    .from(hypotheses)
    .where(eq(hypotheses.anomalyId, anomalyId))
    .orderBy(desc(hypotheses.createdAt))
    .limit(1);

  return (row as HypothesisRow | undefined) ?? null;
}

/**
 * Every model call made about this anomaly, oldest first.
 *
 * Shown per anomaly rather than only in aggregate because the cost claim this
 * project makes is per incident: one anomaly, one classification, at most one
 * correlation. A page that showed only a total would hide a stage that ran
 * three times.
 */
export async function getLlmCalls(anomalyId: string): Promise<LlmCallRow[]> {
  return db
    .select({
      agent: llmCalls.agent,
      provider: llmCalls.provider,
      model: llmCalls.model,
      inputTokens: llmCalls.inputTokens,
      outputTokens: llmCalls.outputTokens,
      latencyMs: llmCalls.latencyMs,
      repairAttempts: llmCalls.repairAttempts,
      succeeded: llmCalls.succeeded,
      createdAt: llmCalls.createdAt,
    })
    .from(llmCalls)
    .where(eq(llmCalls.anomalyId, anomalyId))
    .orderBy(llmCalls.createdAt) as Promise<LlmCallRow[]>;
}

export interface Funnel {
  anomalies: number;
  classified: number;
  realIncidents: number;
  dismissed: number;
  correlated: number;
  attributed: number;
  diagnosed: number;
}

/**
 * The funnel, which is the number the whole two-tier design is argued from.
 *
 * Every anomaly not in `classified` is a model call that never happened, and
 * every dismissed one is a correlation that never happened. Putting it at the
 * top of the page makes the argument visible without reading a document.
 */
export async function getFunnel(): Promise<Funnel> {
  const [counts] = await db
    .select({
      anomalies: sql<number>`count(*)`,
      classified: sql<number>`sum(case when ${anomalies.severity} is not null then 1 else 0 end)`,
      realIncidents: sql<number>`sum(case when ${anomalies.isRealIncident} = 1 then 1 else 0 end)`,
      dismissed: sql<number>`sum(case when ${anomalies.isRealIncident} = 0 then 1 else 0 end)`,
    })
    .from(anomalies);

  const [correlated] = await db
    .select({
      correlated: sql<number>`count(*)`,
      attributed: sql<number>`sum(case when ${correlations.suspectedCommitSha} is not null then 1 else 0 end)`,
    })
    .from(correlations);

  const [diagnosed] = await db.select({ n: sql<number>`count(*)` }).from(hypotheses);

  return {
    anomalies: counts?.anomalies ?? 0,
    classified: counts?.classified ?? 0,
    realIncidents: counts?.realIncidents ?? 0,
    dismissed: counts?.dismissed ?? 0,
    correlated: correlated?.correlated ?? 0,
    attributed: correlated?.attributed ?? 0,
    diagnosed: diagnosed?.n ?? 0,
  };
}

export interface WindowSample {
  timestamp: Date;
  level: string;
  message: string;
  endpoint: string | null;
  statusCode: number | null;
}

/**
 * A few raw log lines from the window, error-level first.
 *
 * Deliberately a small sample and not the evidence packet. The packet is what
 * the MODEL saw and is reproduced verbatim elsewhere on the page; this is here
 * so a reader can see the underlying data was real, without scrolling past two
 * thousand lines to reach the verdict.
 */
export async function getWindowSample(
  service: string,
  windowStart: Date,
  windowEnd: Date,
  limit = 12,
): Promise<WindowSample[]> {
  const rows = await db
    .select({
      timestamp: logs.timestamp,
      level: logs.level,
      message: logs.message,
      metadata: logs.metadata,
    })
    .from(logs)
    .where(
      and(
        eq(logs.service, service),
        gte(logs.timestamp, windowStart),
        lt(logs.timestamp, windowEnd),
        inArray(logs.level, ["error", "fatal", "warn"]),
      ),
    )
    .limit(limit);

  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { endpoint?: string; statusCode?: number };
    return {
      timestamp: row.timestamp,
      level: row.level,
      message: row.message,
      endpoint: meta.endpoint ?? null,
      statusCode: meta.statusCode ?? null,
    };
  });
}
