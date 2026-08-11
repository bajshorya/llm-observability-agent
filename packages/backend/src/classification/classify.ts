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

/**
 * Tier 2: the LLM stage.
 *
 * Runs over anomalies Tier 1 left unclassified, and does so as a separate pass
 * rather than inside the detection engine. Detection stays runnable with no
 * key, no network and no cost — which is the property that lets the honest
 * claim "the statistical layer works on its own" keep being true.
 */

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

  const [metrics, signatures, errorLines, healthyLines] = await Promise.all([
    loadMetrics(service, windowStart, windowEnd),
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
