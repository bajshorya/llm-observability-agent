/**
 * Tier 2 orchestration — loading evidence, calling the model, persisting the
 * verdict.
 *
 * WHAT THIS FILE DOES
 * For each unclassified anomaly: assembles the evidence packet from the
 * database, renders it, sends it through `generateStructured`, and writes back
 * severity, summary and is_real_incident. It is the impure counterpart to the
 * pure `context.ts`.
 *
 * WHY IT IS A SEPARATE PASS FROM DETECTION
 * Tier 2 runs as its own command rather than inside the detection engine. That
 * keeps detection runnable with no key, no network and no cost — which is the
 * property that lets "the statistical layer works on its own" stay true rather
 * than becoming a claim nobody can check.
 *
 * WHAT "UNCLASSIFIED" MEANS, AND WHY IT IS NOT A STATUS
 * `severity IS NULL`. Status tracks the incident's lifecycle and later phases
 * will move it; the NULL columns are the ones Tier 1 declared it does not own.
 * Keying off them means an anomaly is never classified twice however its status
 * later changes — which is what makes `pnpm classify` safe to run on a loop.
 *
 * FIVE QUERIES PER ANOMALY, RUN IN PARALLEL
 *   loadMetrics          totals — percentiles from rollups, counts from logs
 *   loadTimeline         the window minute by minute
 *   loadEndpointMetrics  per-path latency and error counts
 *   loadSignatures       error signatures grouped with counts, in SQL
 *   loadLogLines         raw lines, error/warn and info separately
 *
 * THE ONE DELIBERATE DEPARTURE FROM "DETECTION READS AGGREGATES"
 * Counts come from the raw log table, not the rollups. The rollup worker
 * resumes from its last written bucket, so logs arriving for an
 * already-aggregated minute leave that bucket stale. Tier 1 tolerates it — it
 * compares shapes, and an understated count still clears a 3σ bar. A prompt
 * cannot: telling a model "67 errors" directly above a signature table listing
 * 351 occurrences hands it contradictory evidence and invites it to reconcile
 * the two by guessing. That is not hypothetical; it was observed. Two indexed
 * queries are worth the correctness.
 *
 * A FIELD THAT WAS BEING THROWN AWAY
 * `affectedArea` is persisted as of Phase 3. The classifier had produced it
 * since this tier was built — the CLI printed it, the eval scored it — but
 * nothing wrote it to the row, so it lived only as long as the process that
 * generated it. Correlation is the first consumer that needs it later than the
 * call that produced it, which is how the gap surfaced.
 *
 * THE STATUS TRANSITION THIS FILE OWNS
 * A benign verdict sets status to `dismissed`. That is the entire point of the
 * tier — statistics flagged it, reading it said otherwise — and without it the
 * correlation agent would go looking for the commit that caused a deploy
 * restart.
 *
 * FAILURE HANDLING
 * One anomaly failing does not stop the run; the row keeps its NULL severity
 * and is picked up next time. That is right for the most likely cause — a
 * free-tier quota that resets in an hour. `limit` defaults to 10 so a backlog
 * cannot drain a day's quota in a single run.
 *
 * ROW SCAN CAPS
 * 2000 rows of each kind per anomaly, purely to give the sampler a window to
 * spread across. The caps are EQUAL for a reason learned the hard way: healthy
 * rows were once capped ten times lower, which covered the first twenty-five
 * seconds of a busy window and silently discarded every announcement made after
 * it — including the line saying the incident had ended.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  classificationSchema,
  type Classification,
  type LlmCallStats,
  type LogLevel,
} from "@obs/shared";
import { db } from "../db/client";
import { anomalies, logs, metricsRollup } from "../db/schema";
import { mean } from "../detection/stats";
import { recordLlmCall } from "../llm/calls";
import { createProvider } from "../llm";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import {
  renderClassificationContext,
  type ClassificationInput,
  type ContextLogLine,
  type ContextSignature,
} from "./context";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt";

/** Sentinel endpoint for service-wide rollup rows. */
const SERVICE_LEVEL = "";

/**
 * Upper bound on rows pulled per anomaly. The prompt only ever shows ~20 of
 * these; the rest exist so the sampler has a window to spread across.
 *
 * The caps are equal for a reason learned the hard way. Healthy rows were
 * originally capped an order of magnitude lower, on the assumption that
 * routine traffic is interchangeable and a handful is as good as a thousand.
 * It is not: service narration — deploy banners, "rollout complete", batch job
 * start and finish lines — is info-level, and those are the lines that explain
 * a window. A 200-row cap on a service handling 240 requests a minute covered
 * the first twenty-five seconds and silently discarded every announcement made
 * after that, including the one saying the incident had ended.
 *
 * Above the cap the scan still takes the earliest rows, biasing the sample
 * toward the start of the window. Accepted: the aggregate counts and signature
 * table carry the shape, and the raw lines are illustrative.
 */
const MAX_ERROR_ROWS_SCANNED = 2000;
const MAX_HEALTHY_ROWS_SCANNED = 2000;

export type ClassificationStatus = "classified" | "failed";

export interface ClassificationOutcome {
  anomalyId: string;
  service: string;
  status: ClassificationStatus;
  classification?: Classification;
  stats?: LlmCallStats;
  error?: string;
}

export interface ClassificationRunResult {
  provider: string;
  model: string;
  outcomes: ClassificationOutcome[];
}

export interface ClassifyOptions {
  provider?: LlmProvider | undefined;
  /** Cap per run, so a backlog cannot empty a free-tier quota in one go. */
  limit?: number | undefined;
  /** Classify one specific anomaly, even if already classified. */
  anomalyId?: string | undefined;
}

interface PendingAnomaly {
  id: string;
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: ClassificationInput["triggers"];
}

async function loadPending(options: ClassifyOptions): Promise<PendingAnomaly[]> {
  const columns = {
    id: anomalies.id,
    service: anomalies.service,
    windowStart: anomalies.windowStart,
    windowEnd: anomalies.windowEnd,
    triggers: anomalies.triggers,
  };

  if (options.anomalyId) {
    return db.select(columns).from(anomalies).where(eq(anomalies.id, options.anomalyId));
  }

  /**
   * "Unclassified" is `severity IS NULL` rather than a status value. Status
   * tracks the incident's lifecycle; the null columns are the ones Tier 1
   * declares it does not own. Keying off them means an anomaly is never
   * classified twice, however its status later moves.
   */
  return db
    .select(columns)
    .from(anomalies)
    .where(isNull(anomalies.severity))
    .orderBy(asc(anomalies.detectedAt))
    .limit(options.limit ?? 10);
}

/**
 * Window metrics for the prompt.
 *
 * Counts come from the log table, not the rollups, which is the one place this
 * stage deliberately departs from "detection reads aggregates". The rollup
 * worker resumes from its last written bucket, so logs arriving for a minute
 * that has already been aggregated — a backfill, a late-delivering collector,
 * an injected demo scenario — leave that bucket stale. Tier 1 tolerates that:
 * it is comparing shapes, and an understated count still clears a 3σ bar.
 *
 * A prompt cannot tolerate it. Telling a model "67 errors" directly above a
 * signature table listing 351 occurrences of one error hands it contradictory
 * evidence and invites it to reconcile the two by guessing. Counts are two
 * indexed queries; correctness here is worth them.
 *
 * Latency percentiles still come from the rollups — per-minute percentiles are
 * the only place they exist, and averaging them matches how Tier 1 read them.
 */
async function loadMetrics(
  service: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ClassificationInput["metrics"]> {
  const inWindow = and(
    eq(logs.service, service),
    gte(logs.timestamp, windowStart),
    lt(logs.timestamp, windowEnd),
  );

  const [buckets, [counts]] = await Promise.all([
    db
      .select({
        p50Ms: metricsRollup.p50Ms,
        p95Ms: metricsRollup.p95Ms,
        p99Ms: metricsRollup.p99Ms,
      })
      .from(metricsRollup)
      .where(
        and(
          eq(metricsRollup.service, service),
          eq(metricsRollup.endpoint, SERVICE_LEVEL),
          gte(metricsRollup.bucketStart, windowStart),
          lt(metricsRollup.bucketStart, windowEnd),
        ),
      ),
    db
      .select({
        // Every log entry in this system represents one handled request —
        // the same definition the rollup worker accumulates on.
        requestCount: sql<number>`count(*)`,
        errorCount: sql<number>`sum(case when ${logs.level} in ('error', 'fatal') then 1 else 0 end)`,
      })
      .from(logs)
      .where(inWindow),
  ]);

  return {
    requestCount: counts?.requestCount ?? 0,
    errorCount: counts?.errorCount ?? 0,
    p50Ms: Math.round(mean(buckets.map((b) => b.p50Ms))),
    p95Ms: Math.round(mean(buckets.map((b) => b.p95Ms))),
    p99Ms: Math.round(mean(buckets.map((b) => b.p99Ms))),
  };
}

/**
 * The window minute by minute.
 *
 * Same service-wide rollup rows `loadMetrics` reads, kept in sequence instead
 * of collapsed into totals. Whether an incident is growing, steady or already
 * over is the single most decision-relevant thing about it, and averaging the
 * window destroys exactly that.
 */
async function loadTimeline(
  service: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ClassificationInput["timeline"]> {
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
        eq(metricsRollup.endpoint, SERVICE_LEVEL),
        gte(metricsRollup.bucketStart, windowStart),
        lt(metricsRollup.bucketStart, windowEnd),
      ),
    )
    .orderBy(asc(metricsRollup.bucketStart));
}

/**
 * Per-endpoint latency, read from the rollup rows the worker already writes.
 *
 * This is what separates "the service is slow" from "one background path is
 * slow and users are fine" — two windows with an identical service-wide p95
 * and completely different verdicts.
 */
async function loadEndpointMetrics(
  service: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ClassificationInput["endpoints"]> {
  const rows = await db
    .select({
      endpoint: metricsRollup.endpoint,
      requestCount: sql<number>`sum(${metricsRollup.requestCount})`,
      errorCount: sql<number>`sum(${metricsRollup.errorCount})`,
      // Mean of per-minute p95s, matching how the service-wide figure is read.
      p95Ms: sql<number>`avg(${metricsRollup.p95Ms})`,
    })
    .from(metricsRollup)
    .where(
      and(
        eq(metricsRollup.service, service),
        // Exclude the service-wide sentinel row; it is reported separately.
        sql`${metricsRollup.endpoint} <> ${SERVICE_LEVEL}`,
        gte(metricsRollup.bucketStart, windowStart),
        lt(metricsRollup.bucketStart, windowEnd),
      ),
    )
    .groupBy(metricsRollup.endpoint);

  return rows.map((row) => ({
    endpoint: row.endpoint,
    requestCount: row.requestCount,
    errorCount: row.errorCount,
    p95Ms: Math.round(row.p95Ms),
  }));
}

async function loadSignatures(
  service: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ContextSignature[]> {
  const rows = await db
    .select({
      signature: logs.errorSignature,
      occurrences: sql<number>`count(*)`,
      // An arbitrary but stable representative of the group.
      sampleMessage: sql<string>`min(${logs.message})`,
    })
    .from(logs)
    .where(
      and(
        eq(logs.service, service),
        gte(logs.timestamp, windowStart),
        lt(logs.timestamp, windowEnd),
        sql`${logs.errorSignature} is not null`,
      ),
    )
    .groupBy(logs.errorSignature);

  return rows
    .filter((row): row is typeof row & { signature: string } => row.signature !== null)
    .map((row) => ({
      signature: row.signature,
      occurrences: row.occurrences,
      sampleMessage: row.sampleMessage,
    }));
}

async function loadLogLines(
  service: string,
  windowStart: Date,
  windowEnd: Date,
  levels: readonly LogLevel[],
  limit: number,
): Promise<ContextLogLine[]> {
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
        inArray(logs.level, [...levels]),
        gte(logs.timestamp, windowStart),
        lt(logs.timestamp, windowEnd),
      ),
    )
    .orderBy(asc(logs.timestamp))
    .limit(limit);

  return rows.map((row) => ({
    timestamp: row.timestamp,
    level: row.level,
    message: row.message,
    endpoint: row.metadata.endpoint,
    statusCode: row.metadata.statusCode,
  }));
}

/** Assemble everything the classifier sees for one anomaly. */
export async function buildClassificationInput(
  anomaly: PendingAnomaly,
): Promise<ClassificationInput> {
  const { service, windowStart, windowEnd } = anomaly;

  const [metrics, timeline, endpoints, signatures, errorLines, healthyLines] = await Promise.all([
    loadMetrics(service, windowStart, windowEnd),
    loadTimeline(service, windowStart, windowEnd),
    loadEndpointMetrics(service, windowStart, windowEnd),
    loadSignatures(service, windowStart, windowEnd),
    loadLogLines(service, windowStart, windowEnd, ["error", "fatal", "warn"], MAX_ERROR_ROWS_SCANNED),
    loadLogLines(service, windowStart, windowEnd, ["info"], MAX_HEALTHY_ROWS_SCANNED),
  ]);

  return {
    service,
    windowStart,
    windowEnd,
    triggers: anomaly.triggers,
    metrics,
    timeline,
    endpoints,
    signatures,
    logLines: [...errorLines, ...healthyLines],
    // One log entry per request, so the sample was drawn from exactly these.
    totalLogLines: metrics.requestCount,
  };
}

/**
 * Persist the verdict.
 *
 * A window the classifier judges benign is dismissed here. That is the whole
 * point of the tier: statistics flagged it, reading it said otherwise, and
 * without this the correlation stage would go looking for the commit that
 * caused a deploy restart.
 */
async function persistClassification(
  anomalyId: string,
  classification: Classification,
): Promise<void> {
  await db
    .update(anomalies)
    .set({
      severity: classification.severity,
      summary: classification.summary,
      isRealIncident: classification.isRealIncident,
      affectedArea: classification.affectedArea,
      status: classification.isRealIncident ? "open" : "dismissed",
    })
    .where(eq(anomalies.id, anomalyId));
}

export async function classifyAnomalies(
  options: ClassifyOptions = {},
): Promise<ClassificationRunResult> {
  const provider = options.provider ?? createProvider();
  const pending = await loadPending(options);
  const outcomes: ClassificationOutcome[] = [];

  for (const anomaly of pending) {
    const input = await buildClassificationInput(anomaly);

    try {
      const { value, stats } = await generateStructured({
        provider,
        schema: classificationSchema,
        system: CLASSIFIER_SYSTEM_PROMPT,
        user: renderClassificationContext(input),
        agent: "classifier",
        anomalyId: anomaly.id,
        onCall: recordLlmCall,
      });

      await persistClassification(anomaly.id, value);

      outcomes.push({
        anomalyId: anomaly.id,
        service: anomaly.service,
        status: "classified",
        classification: value,
        stats,
      });
    } catch (error) {
      /**
       * One anomaly failing does not stop the run. The row keeps its null
       * severity and is picked up next time, which is the right behaviour for
       * the most likely cause: a free-tier quota that resets in an hour.
       */
      outcomes.push({
        anomalyId: anomaly.id,
        service: anomaly.service,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { provider: provider.name, model: provider.model, outcomes };
}

export interface ClassificationFunnel {
  anomalies: number;
  classified: number;
  realIncidents: number;
  dismissed: number;
}

/**
 * The funnel, which is the number the two-tier design is argued from: how many
 * windows Tier 1 raised, and how many of those the LLM was actually asked
 * about. Every anomaly not in `classified` is a model call that never happened.
 */
export async function classificationFunnel(): Promise<ClassificationFunnel> {
  const [row] = await db
    .select({
      anomalies: sql<number>`count(*)`,
      classified: sql<number>`sum(case when ${anomalies.severity} is not null then 1 else 0 end)`,
      realIncidents: sql<number>`sum(case when ${anomalies.isRealIncident} = 1 then 1 else 0 end)`,
      dismissed: sql<number>`sum(case when ${anomalies.isRealIncident} = 0 then 1 else 0 end)`,
    })
    .from(anomalies);

  return {
    anomalies: row?.anomalies ?? 0,
    classified: row?.classified ?? 0,
    realIncidents: row?.realIncidents ?? 0,
    dismissed: row?.dismissed ?? 0,
  };
}

export interface RenderedContext {
  anomalyId: string;
  service: string;
  context: string;
}

/**
 * Build the evidence packet for one anomaly, defaulting to the most recent.
 *
 * The default is what makes capturing a golden case a single command: inject a
 * scenario, detect, capture — with no id to copy between steps.
 */
export async function renderContextForAnomaly(
  anomalyId?: string,
): Promise<RenderedContext | null> {
  const columns = {
    id: anomalies.id,
    service: anomalies.service,
    windowStart: anomalies.windowStart,
    windowEnd: anomalies.windowEnd,
    triggers: anomalies.triggers,
  };

  const [anomaly] = anomalyId
    ? await db.select(columns).from(anomalies).where(eq(anomalies.id, anomalyId))
    : await db.select(columns).from(anomalies).orderBy(desc(anomalies.detectedAt)).limit(1);

  if (!anomaly) return null;

  const input = await buildClassificationInput(anomaly);
  return {
    anomalyId: anomaly.id,
    service: anomaly.service,
    context: renderClassificationContext(input),
  };
}

/** Render the full prompt for an anomaly without calling anything. */
export async function previewPrompt(anomalyId: string): Promise<string | null> {
  const rendered = await renderContextForAnomaly(anomalyId);
  if (!rendered) return null;

  return `${CLASSIFIER_SYSTEM_PROMPT}\n\n---\n\n${rendered.context}`;
}
