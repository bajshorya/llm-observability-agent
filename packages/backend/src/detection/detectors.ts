/**
 * Tier 1 — the three statistical detectors. The heart of the cheap tier.
 *
 * WHAT THIS FILE DOES
 * Takes a summary of the window under test and a summary of the trailing
 * baseline, and returns every trigger that fired. Three detectors, one entry
 * point (`runDetectors`), no side effects.
 *
 * THESE ARE PURE FUNCTIONS, AND THAT IS THE POINT
 * Statistics in, triggers out. No database, no clock, no I/O. This is the layer
 * that can be *proven* correct with fixed inputs and known expected outputs —
 * which is precisely what earns it the right to sit in front of an LLM and
 * decide what the LLM never sees. Everything that touches the database lives in
 * `engine.ts`; the split is deliberate and load-bearing.
 *
 * THE THREE DETECTORS
 *
 *   detectErrorRateSpike
 *     Errors per minute in the window exceed mean + k·σ of the baseline.
 *     Catches volume: something is failing much more than it usually does.
 *
 *   detectLatencyJump
 *     Window p95 is a large multiple of the baseline p95. Note the baseline
 *     uses the MEDIAN of per-minute p95s, not the mean — see `stats.ts` for
 *     why that asymmetry exists.
 *     Catches degradation with no errors at all: everything works, slowly.
 *
 *   detectNewErrorSignature
 *     A normalised signature present in the window and absent from the entire
 *     baseline hour. This is the only detector that can catch a brand-new
 *     failure on its FIRST occurrence, before it has had time to become a
 *     spike — and it depends entirely on signature normalisation working.
 *     When several novel signatures appear at once the most frequent is
 *     reported; the rest stay visible in the anomaly's log window.
 *
 *   detectSilence  (separate entry point, not part of `runDetectors`)
 *     A normally busy service has sent nothing for a whole window. The only
 *     detector judged against NOW rather than the newest data, because a dead
 *     service produces no newest data — the others freeze on its last healthy
 *     minute and report clean. `now` is passed in, so it is still pure.
 *
 * SHARED STRUCTURE
 * Every detector checks its absolute floor FIRST — it is the cheapest test and
 * rejects the noisiest case — then the relative threshold, then builds a
 * trigger carrying the evidence that justified it. Returning `null` means "did
 * not fire", and `runDetectors` filters those out.
 *
 * An incident commonly sets off more than one detector, and each carries
 * independent evidence, so all firing triggers are kept rather than the first.
 *
 * ONE GUARD WORTH KNOWING: `safeZScore`
 * A zero-variance baseline produces an infinite z-score, and
 * `JSON.stringify(Infinity)` is `null` — which would silently corrupt a stored
 * trigger. It is clamped to 999, which still reads as "far outside normal".
 */

import type { AnomalyTrigger } from "@obs/shared";
import type { DetectionConfig } from "./config";
import { mean, median, stdDev } from "./stats";

export interface SignatureOccurrence {
  occurrences: number;
  sampleMessage: string;
}

/** Aggregated view of the window under evaluation. */
export interface WindowStats {
  service: string;
  /** Number of minutes the window spans — used to normalise counts. */
  minutes: number;
  requestCount: number;
  errorCount: number;
  p95Ms: number;
  p99Ms: number;
  signatures: ReadonlyMap<string, SignatureOccurrence>;
}

/** Trailing history the window is compared against. */
export interface BaselineStats {
  /** One entry per minute of baseline, so spread can be measured. */
  errorCountsPerMinute: readonly number[];
  p95PerMinute: readonly number[];
  signatures: ReadonlySet<string>;
  /** Minutes of baseline actually available (may be less than configured). */
  minutes: number;
}

/**
 * JSON has no representation for Infinity — `JSON.stringify(Infinity)` is
 * `null`, which would silently corrupt a stored trigger. A zero-variance
 * baseline produces an infinite z-score, so it is clamped to a large finite
 * value that still reads as "far outside normal".
 */
const MAX_Z_SCORE = 999;

function safeZScore(observed: number, baselineMean: number, baselineStdDev: number): number {
  if (baselineStdDev <= 0) {
    return observed > baselineMean ? MAX_Z_SCORE : 0;
  }
  return Number(((observed - baselineMean) / baselineStdDev).toFixed(2));
}

/**
 * Error-rate spike: errors per minute in the window exceed
 * `mean + k·stddev` of the trailing baseline.
 */
export function detectErrorRateSpike(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  const observedPerMinute = window.errorCount / Math.max(window.minutes, 1);

  // Absolute floor first — it is the cheapest check and rejects the noisiest case.
  if (observedPerMinute < config.errorRate.minErrorsPerMinute) return null;

  const baselineMean = mean(baseline.errorCountsPerMinute);
  const baselineStdDev = stdDev(baseline.errorCountsPerMinute);
  const threshold = baselineMean + config.errorRate.stdDevMultiplier * baselineStdDev;

  if (observedPerMinute <= threshold) return null;

  return {
    kind: "error_rate_spike",
    service: window.service,
    observedErrors: window.errorCount,
    baselineMean: Number(baselineMean.toFixed(2)),
    baselineStdDev: Number(baselineStdDev.toFixed(2)),
    zScore: safeZScore(observedPerMinute, baselineMean, baselineStdDev),
  };
}

/**
 * Latency jump: window p95 is a large multiple of the baseline p95.
 *
 * The baseline uses the **median** of per-minute p95s rather than the mean, so
 * a latency spike already sitting in the baseline window cannot drag the bar
 * upwards — which would make the detector least sensitive exactly when a
 * service has recently been misbehaving.
 */
export function detectLatencyJump(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  if (window.p95Ms < config.latency.minObservedMs) return null;

  const baselineP95 = median(baseline.p95PerMinute);
  // Nothing meaningful to compare against yet.
  if (baselineP95 <= 0) return null;

  const ratio = window.p95Ms / baselineP95;
  if (ratio < config.latency.ratioThreshold) return null;

  return {
    kind: "latency_jump",
    service: window.service,
    metric: "p95",
    observedMs: Math.round(window.p95Ms),
    baselineMs: Math.round(baselineP95),
    ratio: Number(ratio.toFixed(2)),
  };
}

/**
 * New error signature: a normalised signature that appears in the window but
 * nowhere in the baseline.
 *
 * This is the only detector that can catch a brand-new failure on its first
 * occurrence, before it has had time to become a statistical spike. It depends
 * entirely on signature normalisation working — without it, ordinary id
 * variation would make almost every error look novel.
 *
 * When several novel signatures appear at once, the most frequent is reported;
 * the rest remain visible in the anomaly's log window.
 */
export function detectNewErrorSignature(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  let best: { signature: string; occurrence: SignatureOccurrence } | null = null;

  for (const [signature, occurrence] of window.signatures) {
    if (baseline.signatures.has(signature)) continue;
    if (occurrence.occurrences < config.newSignature.minOccurrences) continue;
    if (!best || occurrence.occurrences > best.occurrence.occurrences) {
      best = { signature, occurrence };
    }
  }

  if (!best) return null;

  return {
    kind: "new_error_signature",
    service: window.service,
    signature: best.signature,
    sampleMessage: best.occurrence.sampleMessage,
    occurrences: best.occurrence.occurrences,
  };
}

/**
 * Run every detector. Returns all triggers that fired — an incident commonly
 * sets off more than one, and each carries independent evidence worth keeping.
 */
export function runDetectors(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger[] {
  return [
    detectErrorRateSpike(window, baseline, config),
    detectLatencyJump(window, baseline, config),
    detectNewErrorSignature(window, baseline, config),
  ].filter((trigger): trigger is AnomalyTrigger => trigger !== null);
}

/** What the silence detector needs about one service. Plain values, no clock. */
export interface SilenceInput {
  service: string;
  /** Timestamp of the newest log line received from the service. */
  lastSeenAt: Date;
  /** Log lines per minute in the `silence.baselineMinutes` before `lastSeenAt`. */
  baselineLinesPerMinute: number;
}

/**
 * Fires when a normally busy service has stopped logging.
 *
 * Kept OUT of `runDetectors` deliberately. The other three compare a window
 * against a baseline, and both are anchored to the newest data; this one
 * compares the newest data against NOW, which is the only way to see an
 * absence. `now` is a parameter, so the function stays pure and testable —
 * the engine is the only place that reads the clock.
 *
 * Three gates, in order of cost:
 *   - heard from too long ago      → out of scope (old database, retired service)
 *   - quiet for less than a window → not silence, just a gap
 *   - normally sends little        → gaps are normal for it; not abnormal
 */
export function detectSilence(
  input: SilenceInput,
  now: Date,
  config: DetectionConfig,
): AnomalyTrigger | null {
  const silentMs = now.getTime() - input.lastSeenAt.getTime();
  const silentMinutes = silentMs / 60_000;

  if (silentMinutes > config.silence.maxLookbackMinutes) return null;
  if (silentMinutes < config.silence.minSilentMinutes) return null;
  if (input.baselineLinesPerMinute < config.silence.minBaselineLinesPerMinute) return null;

  return {
    kind: "service_silent",
    service: input.service,
    lastSeenAt: input.lastSeenAt.toISOString(),
    silentMinutes: Math.floor(silentMinutes),
    baselineLinesPerMinute: Number(input.baselineLinesPerMinute.toFixed(1)),
  };
}
