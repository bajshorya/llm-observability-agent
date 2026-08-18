/**
 * Tier 1 output — what the cheap statistical detectors found, and the vocabulary
 * for an anomaly's whole lifecycle.
 *
 * WHAT THIS FILE DOES
 * Defines the shapes Tier 1 produces and Tier 2 consumes. No LLM has seen the
 * data at this point: an anomaly candidate is a time window plus the signal(s)
 * that tripped — enough for a human to understand the alert on its own, and
 * enough context to hand to Tier 1's more expensive successor.
 *
 * WHAT IT EXPORTS
 *   - `anomalyStatuses` / `anomalyStatusSchema`
 *         open → correlated → diagnosed, plus dismissed and resolved.
 *         Tier 1 only ever writes `open`; Tier 2 may write `dismissed`;
 *         Phases 3 and 4 own the rest.
 *   - `severities` / `severitySchema`
 *         low | medium | high | critical. Written by Tier 2, never Tier 1.
 *   - `anomalyTriggerSchema`
 *         a DISCRIMINATED UNION on `kind`, with one member per detector.
 *   - `anomalyCandidateSchema`
 *         service + window + at least one trigger. What Tier 1 emits.
 *
 * WHY THE TRIGGERS ARE A DISCRIMINATED UNION
 * Each detector has genuinely different evidence, and flattening that into a
 * shared bag of optional fields would lose it:
 *
 *   error_rate_spike     observed count, baseline mean, standard deviation,
 *                        z-score — the numbers that justify the alert.
 *   latency_jump         which percentile, observed, baseline, ratio.
 *   new_error_signature  the normalised signature, a raw sample message a
 *                        human can actually read, and occurrence count.
 *
 * Because it is discriminated, `switch (trigger.kind)` is exhaustively checked
 * by TypeScript — adding a fourth detector will fail compilation everywhere
 * that renders or interprets triggers, rather than silently falling through.
 * Both CLIs and the evidence builder rely on this.
 *
 * The triggers are stored as JSON on the `anomalies` row, so this schema is
 * also the on-disk format, not just an in-memory type.
 */

import { z } from "zod";

export const anomalyStatuses = [
  "open",
  "correlated",
  "diagnosed",
  "dismissed",
  "resolved",
] as const;
export type AnomalyStatus = (typeof anomalyStatuses)[number];
export const anomalyStatusSchema = z.enum(anomalyStatuses);

export const severities = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof severities)[number];
export const severitySchema = z.enum(severities);

/** Error count in the window sat far above the trailing baseline. */
export const errorRateSpikeTriggerSchema = z.object({
  kind: z.literal("error_rate_spike"),
  service: z.string(),
  observedErrors: z.number().int().nonnegative(),
  baselineMean: z.number().nonnegative(),
  baselineStdDev: z.number().nonnegative(),
  zScore: z.number(),
});

/** Tail latency jumped relative to the trailing baseline. */
export const latencyJumpTriggerSchema = z.object({
  kind: z.literal("latency_jump"),
  service: z.string(),
  metric: z.enum(["p95", "p99"]),
  observedMs: z.number().nonnegative(),
  baselineMs: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
});

/**
 * An error signature that does not appear anywhere in the baseline window.
 * This is the detector that catches a fresh failure on its first occurrence.
 */
export const newErrorSignatureTriggerSchema = z.object({
  kind: z.literal("new_error_signature"),
  service: z.string(),
  signature: z.string(),
  sampleMessage: z.string(),
  occurrences: z.number().int().positive(),
});

export const anomalyTriggerSchema = z.discriminatedUnion("kind", [
  errorRateSpikeTriggerSchema,
  latencyJumpTriggerSchema,
  newErrorSignatureTriggerSchema,
]);

export type AnomalyTrigger = z.infer<typeof anomalyTriggerSchema>;
export type TriggerKind = AnomalyTrigger["kind"];

/** What Tier 1 emits and hands to Tier 2. */
export const anomalyCandidateSchema = z.object({
  service: z.string(),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  triggers: z.array(anomalyTriggerSchema).min(1),
});

export type AnomalyCandidate = z.infer<typeof anomalyCandidateSchema>;
