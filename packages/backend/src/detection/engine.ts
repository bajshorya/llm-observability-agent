/**
 * The detection engine — everything the pure detectors deliberately do not do.
 *
 * WHAT THIS FILE DOES
 * Decides which window to examine, loads the statistics for it, hands them to
 * `runDetectors`, and persists whatever fired. It contains NO detection logic
 * of its own, which is what keeps the provable part provable.
 *
 *     engine.ts  ─── loads ──▶  detectors.ts (pure)  ─── triggers ──▶  engine.ts
 *        │                                                                 │
 *     database                                                          database
 *
 * HOW THE WINDOW IS CHOSEN
 * The window ends at the most recent closed minute PRESENT IN THE ROLLUPS,
 * not at `Date.now()`. That way detection and the rollup worker cannot disagree
 * about where "now" is — otherwise a slow rollup would make every run examine a
 * window with no data in it.
 *
 *   window   = the 5 minutes before that point
 *   baseline = the 60 minutes before the window, with a 1-minute gap so the
 *              window's own data cannot leak into the baseline it is judged
 *              against and quietly raise its own bar
 *
 * PER SERVICE, IN ORDER
 *   1. Load the baseline. If under 30 minutes exist, SKIP and say so — on a
 *      service with no history every signature is novel and every number
 *      unusual, so running detectors early produces a burst of meaningless
 *      anomalies the moment the system starts.
 *   2. Load window stats: counts and percentiles from the rollups, error
 *      signatures from the raw log table.
 *   3. Run the detectors.
 *   4. If anything fired, persist.
 *
 * THE MERGE RULE, WHICH IS WHAT BOUNDS TIER 2'S COST
 * A sustained incident fires on EVERY run. Rather than creating a new anomaly
 * each time, a recent anomaly whose window ended within the merge gap is
 * extended. Without this a ten-minute outage would produce a wall of
 * near-identical rows — and one duplicated LLM call for each of them.
 *
 * Anomalies with status `open` OR `dismissed` are mergeable. Dismissed is
 * included because Tier 2 dismisses benign patterns and the traffic that
 * produced them usually continues; without it, every subsequent run would buy
 * another model call to reach the same verdict.
 *
 * With one guard: folding into a DISMISSED anomaly is only safe while nothing
 * new has happened. A trigger kind that was not part of what the classifier
 * dismissed is evidence it has not seen, so that starts a fresh anomaly and
 * earns its own verdict — otherwise a real incident beginning shortly after a
 * benign one would silently inherit the dismissal and never be looked at.
 *
 * WHAT IT DELIBERATELY LEAVES EMPTY
 * `severity`, `summary` and `is_real_incident` are written as NULL. They belong
 * to Tier 2, and an anomaly is a complete, valid record without them — that is
 * the handoff contract between the tiers.
 */

import { and, desc, eq, gte, inArray, isNotNull, lt, max } from "drizzle-orm";
import type { AnomalyTrigger } from "@obs/shared";
import { db } from "../db/client";
import { anomalies, logs, metricsRollup } from "../db/schema";
import { detectionConfig, type DetectionConfig } from "./config";
import {
  runDetectors,
  type BaselineStats,
  type SignatureOccurrence,
  type WindowStats,
} from "./detectors";
import { mean } from "./stats";

const MINUTE_MS = 60_000;
/** Sentinel endpoint for service-wide rollup rows. */
const SERVICE_LEVEL = "";

export type DetectionAction = "created" | "extended" | "none";

export interface ServiceDetectionResult {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: AnomalyTrigger[];
  action: DetectionAction;
  anomalyId: string | null;
  /** Set when detection was skipped rather than simply finding nothing. */
  skippedReason?: string;
}

export interface DetectionRunResult {
  windowStart: Date;
  windowEnd: Date;
  services: ServiceDetectionResult[];
}

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** Collapse raw error rows into per-signature counts with one sample message. */
function collectSignatures(
  rows: readonly { errorSignature: string | null; message: string }[],
): Map<string, SignatureOccurrence> {
  const signatures = new Map<string, SignatureOccurrence>();
  for (const row of rows) {
    if (!row.errorSignature) continue;
    const existing = signatures.get(row.errorSignature);
    if (existing) {
      existing.occurrences += 1;
    } else {
      signatures.set(row.errorSignature, {
        occurrences: 1,
        // First raw message seen — what a human needs to read the signature.
        sampleMessage: row.message,
      });
    }
  }
  return signatures;
}

async function loadWindowStats(
  service: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<WindowStats> {
  const buckets = await db
    .select({
      requestCount: metricsRollup.requestCount,
      errorCount: metricsRollup.errorCount,
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
    );

  const errorRows = await db
    .select({ errorSignature: logs.errorSignature, message: logs.message })
    .from(logs)
    .where(
      and(
        eq(logs.service, service),
        isNotNull(logs.errorSignature),
        gte(logs.timestamp, windowStart),
        lt(logs.timestamp, windowEnd),
      ),
    );

  /**
   * Window p95 is the mean of the per-minute p95s rather than the max.
   * Averaging dilutes a single spiking minute across the window, which is an
   * accepted trade-off: Tier 1's job is to be cheap and quiet, and a
   * one-minute blip is exactly the kind of thing that should not page anyone.
   */
  return {
    service,
    minutes: Math.max(buckets.length, 1),
    requestCount: buckets.reduce((sum, b) => sum + b.requestCount, 0),
    errorCount: buckets.reduce((sum, b) => sum + b.errorCount, 0),
    p95Ms: mean(buckets.map((b) => b.p95Ms)),
    p99Ms: mean(buckets.map((b) => b.p99Ms)),
    signatures: collectSignatures(errorRows),
  };
}

async function loadBaselineStats(
  service: string,
  baselineStart: Date,
  baselineEnd: Date,
): Promise<BaselineStats> {
  const buckets = await db
    .select({
      errorCount: metricsRollup.errorCount,
      p95Ms: metricsRollup.p95Ms,
    })
    .from(metricsRollup)
    .where(
      and(
        eq(metricsRollup.service, service),
        eq(metricsRollup.endpoint, SERVICE_LEVEL),
        gte(metricsRollup.bucketStart, baselineStart),
        lt(metricsRollup.bucketStart, baselineEnd),
      ),
    );

  const signatureRows = await db
    .selectDistinct({ errorSignature: logs.errorSignature })
    .from(logs)
    .where(
      and(
        eq(logs.service, service),
        isNotNull(logs.errorSignature),
        gte(logs.timestamp, baselineStart),
        lt(logs.timestamp, baselineEnd),
      ),
    );

  const signatures = new Set<string>();
  for (const row of signatureRows) {
    if (row.errorSignature) signatures.add(row.errorSignature);
  }

  return {
    errorCountsPerMinute: buckets.map((b) => b.errorCount),
    p95PerMinute: buckets.map((b) => b.p95Ms),
    signatures,
    minutes: buckets.length,
  };
}

/** Merge triggers, keeping the newest of each kind. */
function mergeTriggers(
  existing: readonly AnomalyTrigger[],
  incoming: readonly AnomalyTrigger[],
): AnomalyTrigger[] {
  const byKind = new Map<AnomalyTrigger["kind"], AnomalyTrigger>();
  for (const trigger of existing) byKind.set(trigger.kind, trigger);
  for (const trigger of incoming) byKind.set(trigger.kind, trigger);
  return [...byKind.values()];
}

/**
 * Statuses an ongoing window is allowed to fold into.
 *
 * `dismissed` is here because Tier 2 dismisses benign patterns — a deploy
 * restart, a load test — and the traffic that produced them usually keeps
 * going. Without this, every subsequent run would create a fresh anomaly for
 * a pattern already judged benign, and each one would buy another LLM call to
 * reach the same verdict.
 */
const MERGEABLE_STATUSES = ["open", "dismissed"] as const;

/**
 * Persist a firing window.
 *
 * A sustained incident fires on every run, so rather than creating a fresh
 * anomaly each time, a recent anomaly whose window ended within the merge gap
 * is extended. Without this a ten-minute outage would produce a wall of
 * near-identical anomalies — and later, a duplicated LLM call for each one.
 */
async function persistAnomaly(
  service: string,
  windowStart: Date,
  windowEnd: Date,
  triggers: AnomalyTrigger[],
  config: DetectionConfig,
): Promise<{ action: DetectionAction; anomalyId: string }> {
  const mergeCutoff = new Date(windowStart.getTime() - config.anomalyMergeGapMinutes * MINUTE_MS);

  const [recentAnomaly] = await db
    .select({
      id: anomalies.id,
      status: anomalies.status,
      windowEnd: anomalies.windowEnd,
      triggers: anomalies.triggers,
    })
    .from(anomalies)
    .where(
      and(
        eq(anomalies.service, service),
        inArray(anomalies.status, [...MERGEABLE_STATUSES]),
        gte(anomalies.windowEnd, mergeCutoff),
      ),
    )
    .orderBy(desc(anomalies.windowEnd))
    .limit(1);

  /**
   * Folding into a dismissed anomaly is only safe while nothing new has
   * happened. A signal that was not part of what the classifier dismissed is
   * evidence it has not seen, so that starts a fresh anomaly and earns its own
   * verdict — otherwise a real incident beginning shortly after a benign one
   * would inherit its dismissal and never be looked at.
   */
  const knownKinds = new Set(recentAnomaly?.triggers.map((trigger) => trigger.kind));
  const openAnomaly =
    recentAnomaly?.status === "dismissed" &&
    triggers.some((trigger) => !knownKinds.has(trigger.kind))
      ? undefined
      : recentAnomaly;

  if (openAnomaly) {
    await db
      .update(anomalies)
      .set({
        windowEnd: windowEnd > openAnomaly.windowEnd ? windowEnd : openAnomaly.windowEnd,
        triggers: mergeTriggers(openAnomaly.triggers, triggers),
        detectedAt: new Date(),
      })
      .where(eq(anomalies.id, openAnomaly.id));

    return { action: "extended", anomalyId: openAnomaly.id };
  }

  const [created] = await db
    .insert(anomalies)
    .values({
      detectedAt: new Date(),
      windowStart,
      windowEnd,
      service,
      triggers,
      status: "open",
    })
    .returning({ id: anomalies.id });

  if (!created) throw new Error("failed to insert anomaly");
  return { action: "created", anomalyId: created.id };
}

/**
 * Run detection across every service that has rollup data.
 *
 * The window ends at the most recent *closed* minute present in the rollups
 * rather than at `Date.now()`, so detection and the rollup worker cannot
 * disagree about where "now" is.
 */
export async function runDetection(
  options: { config?: DetectionConfig; now?: Date } = {},
): Promise<DetectionRunResult> {
  const config = options.config ?? detectionConfig;

  const [latest] = await db
    .select({ value: max(metricsRollup.bucketStart) })
    .from(metricsRollup);

  const latestBucket = latest?.value;
  const windowEndMs = latestBucket
    ? latestBucket.getTime() + MINUTE_MS
    : floorToMinute(options.now?.getTime() ?? Date.now());

  const windowEnd = new Date(windowEndMs);
  const windowStart = new Date(windowEndMs - config.windowMinutes * MINUTE_MS);
  const baselineEnd = new Date(windowStart.getTime() - config.baselineGapMinutes * MINUTE_MS);
  const baselineStart = new Date(baselineEnd.getTime() - config.baselineMinutes * MINUTE_MS);

  const serviceRows = await db
    .selectDistinct({ service: metricsRollup.service })
    .from(metricsRollup)
    .where(gte(metricsRollup.bucketStart, baselineStart));

  const results: ServiceDetectionResult[] = [];

  for (const { service } of serviceRows) {
    const baseline = await loadBaselineStats(service, baselineStart, baselineEnd);

    if (baseline.minutes < config.minBaselineMinutes) {
      results.push({
        service,
        windowStart,
        windowEnd,
        triggers: [],
        action: "none",
        anomalyId: null,
        skippedReason: `only ${baseline.minutes} min of baseline (need ${config.minBaselineMinutes})`,
      });
      continue;
    }

    const window = await loadWindowStats(service, windowStart, windowEnd);
    const triggers = runDetectors(window, baseline, config);

    if (triggers.length === 0) {
      results.push({
        service,
        windowStart,
        windowEnd,
        triggers: [],
        action: "none",
        anomalyId: null,
      });
      continue;
    }

    const { action, anomalyId } = await persistAnomaly(
      service,
      windowStart,
      windowEnd,
      triggers,
      config,
    );

    results.push({ service, windowStart, windowEnd, triggers, action, anomalyId });
  }

  return { windowStart, windowEnd, services: results };
}
