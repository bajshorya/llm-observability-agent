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

import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@obs/backend/src/db/client";
import {
  alerts,
  anomalies,
  correlations,
  hypotheses,
  llmCalls,
  logs,
  metricsRollup,
} from "@obs/backend/src/db/schema";
import type { AnomalyStatus, AnomalyTrigger, Severity } from "@obs/shared";
import type { RollupPoint } from "./chart";
import { sinceOptions, type AnomalyFilters } from "./filters";

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

const hasSilence = sql`exists (
  select 1 from json_each(${anomalies.triggers})
  where json_extract(json_each.value, '$.kind') = 'service_silent'
)`;

function filterConditions(filters: AnomalyFilters, now: Date): SQL[] {
  const conditions: SQL[] = [];
  if (filters.service) conditions.push(eq(anomalies.service, filters.service));
  if (filters.severity) conditions.push(eq(anomalies.severity, filters.severity));
  if (filters.status) conditions.push(eq(anomalies.status, filters.status));

  switch (filters.verdict) {
    case "real":
      conditions.push(eq(anomalies.isRealIncident, true));
      break;
    case "dismissed":
      conditions.push(eq(anomalies.isRealIncident, false));
      break;
    case "unclassified":
      conditions.push(isNull(anomalies.severity));
      break;
    case "silent":
      conditions.push(hasSilence);
      break;
    case null:
      break;
  }

  const minutes = sinceOptions[filters.since];
  if (minutes !== null) {
    conditions.push(gte(anomalies.detectedAt, new Date(now.getTime() - minutes * 60_000)));
  }

  if (filters.q) {
    // LIKE wildcards in the user's text are escaped, so "50%" means fifty percent.
    const escaped = filters.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const match = or(
      sql`${anomalies.summary} like ${pattern} escape '\\'`,
      sql`${anomalies.service} like ${pattern} escape '\\'`,
      sql`${anomalies.id} like ${`${escaped}%`} escape '\\'`,
    );
    if (match) conditions.push(match);
  }

  return conditions;
}

/** Newest first — an on-call view is always "what just happened". */
export async function listAnomalies(
  filters: AnomalyFilters | null = null,
  limit = 100,
  now: Date = new Date(),
): Promise<AnomalyRow[]> {
  const conditions = filters ? filterConditions(filters, now) : [];
  return db
    .select(ANOMALY_COLUMNS)
    .from(anomalies)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(anomalies.detectedAt))
    .limit(limit) as Promise<AnomalyRow[]>;
}

/** Every service that has ever raised an anomaly — the filter's options. */
export async function listServices(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ service: anomalies.service })
    .from(anomalies)
    .orderBy(anomalies.service);
  return rows.map((row) => row.service);
}

/**
 * Service-wide per-minute rollups in [from, to) — what the charts draw.
 *
 * The same rows Tier 1 reads, so the chart shows what the detectors measured.
 * They can understate a minute that received late logs (see the rollup
 * staleness note in CODEBASE.md §19); the evidence packet counts from raw logs
 * and is the authority on exact numbers.
 */
export async function getSeries(service: string, from: Date, to: Date): Promise<RollupPoint[]> {
  return db
    .select({
      bucketStart: metricsRollup.bucketStart,
      requestCount: metricsRollup.requestCount,
      errorCount: metricsRollup.errorCount,
      p95Ms: metricsRollup.p95Ms,
    })
    .from(metricsRollup)
    .where(
      and(
        eq(metricsRollup.service, service),
        eq(metricsRollup.endpoint, ""),
        gte(metricsRollup.bucketStart, from),
        lt(metricsRollup.bucketStart, to),
      ),
    )
    .orderBy(metricsRollup.bucketStart);
}

export interface AlertRow {
  reason: string;
  channel: string;
  succeeded: boolean;
  error: string | null;
  createdAt: Date;
}

/**
 * Every alert attempt for this anomaly. Returns [] on a database created
 * before the alerts table existed, rather than failing the whole page.
 */
export async function getAlerts(anomalyId: string): Promise<AlertRow[]> {
  try {
    return await db
      .select({
        reason: alerts.reason,
        channel: alerts.channel,
        succeeded: alerts.succeeded,
        error: alerts.error,
        createdAt: alerts.createdAt,
      })
      .from(alerts)
      .where(eq(alerts.anomalyId, anomalyId))
      .orderBy(alerts.createdAt);
  } catch {
    return [];
  }
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

// --- cost --------------------------------------------------------------------

export interface UsageGroup {
  key: string;
  calls: number;
  /** `1 + repairAttempts` per call — what the provider actually counted. */
  requests: number;
  failed: number;
  repairs: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
}

export interface DayUsage {
  /** YYYY-MM-DD, UTC. */
  day: string;
  requests: number;
  failed: number;
}

export interface TodayUsage {
  provider: string;
  model: string;
  requests: number;
}

export interface CostSummary {
  total: UsageGroup;
  byAgent: UsageGroup[];
  byModel: UsageGroup[];
  byDay: DayUsage[];
  today: TodayUsage[];
  /** Anomalies that cost at least one call, and how many Tier 1 raised in all. */
  anomaliesWithCalls: number;
  anomaliesTotal: number;
}

const usageColumns = {
  calls: sql<number>`count(*)`,
  requests: sql<number>`coalesce(sum(1 + ${llmCalls.repairAttempts}), 0)`,
  failed: sql<number>`coalesce(sum(case when ${llmCalls.succeeded} = 0 then 1 else 0 end), 0)`,
  repairs: sql<number>`coalesce(sum(${llmCalls.repairAttempts}), 0)`,
  inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`,
  avgLatencyMs: sql<number>`coalesce(avg(${llmCalls.latencyMs}), 0)`,
};

/**
 * Where the model budget went.
 *
 * Tokens, not currency — every provider in use is a free tier, and a dollar
 * column reading 0.00 would imply a precision that is not there (CODEBASE.md
 * §19). Requests are counted as the provider counts them: a schema repair is
 * a second request, and is charged against the daily quota like the first.
 *
 * `today` is grouped by provider AND model because free-tier quotas are per
 * model — it is the number that says whether the next run will hit a 429.
 */
export async function getCostSummary(days = 14, now: Date = new Date()): Promise<CostSummary> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(dayStart.getTime() - (days - 1) * 86_400_000);
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${llmCalls.createdAt} / 1000, 'unixepoch')`;

  const [total] = await db.select({ key: sql<string>`'all'`, ...usageColumns }).from(llmCalls);

  const byAgent = await db
    .select({ key: llmCalls.agent, ...usageColumns })
    .from(llmCalls)
    .groupBy(llmCalls.agent)
    .orderBy(desc(sql`count(*)`));

  const byModel = await db
    .select({ key: sql<string>`${llmCalls.provider} || ' · ' || ${llmCalls.model}`, ...usageColumns })
    .from(llmCalls)
    .groupBy(llmCalls.provider, llmCalls.model)
    .orderBy(desc(sql`count(*)`));

  const dayRows = await db
    .select({ day: dayExpr, requests: usageColumns.requests, failed: usageColumns.failed })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, since))
    .groupBy(dayExpr);

  // A dense run of days, so a day with no calls is drawn as zero, not skipped.
  const byDayMap = new Map(dayRows.map((row) => [row.day, row]));
  const byDay: DayUsage[] = Array.from({ length: days }, (_, i) => {
    const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const row = byDayMap.get(day);
    return { day, requests: row?.requests ?? 0, failed: row?.failed ?? 0 };
  });

  const today = await db
    .select({ provider: llmCalls.provider, model: llmCalls.model, requests: usageColumns.requests })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, dayStart))
    .groupBy(llmCalls.provider, llmCalls.model)
    .orderBy(desc(usageColumns.requests));

  const [withCalls] = await db
    .select({ n: sql<number>`count(distinct ${llmCalls.anomalyId})` })
    .from(llmCalls);
  const [anomalyTotal] = await db.select({ n: sql<number>`count(*)` }).from(anomalies);

  const empty: UsageGroup = {
    key: "all", calls: 0, requests: 0, failed: 0, repairs: 0, inputTokens: 0, outputTokens: 0, avgLatencyMs: 0,
  };

  return {
    total: total ?? empty,
    byAgent,
    byModel,
    byDay,
    today,
    anomaliesWithCalls: withCalls?.n ?? 0,
    anomaliesTotal: anomalyTotal?.n ?? 0,
  };
}
