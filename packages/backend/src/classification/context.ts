/**
 * Building the classifier's evidence packet — deciding what the model sees.
 *
 * WHAT THIS FILE DOES
 * Turns a window's raw data into the text sent to the model. It is a
 * SUMMARISER, and it is PURE: same window in, same prompt out, no clock and no
 * database. That purity is what makes the prompt reproducible, which is what
 * makes a regression in classification quality attributable to the prompt
 * rather than to whatever the sampler happened to pick that run.
 *
 * THE PROBLEM IT SOLVES
 * A five-minute window on a busy service is tens of thousands of log lines.
 * Sending them all is impossible. Sending the first N is worse than useless —
 * the first N lines of an incident are the healthy traffic that preceded it.
 *
 * THE PACKET HAS FOUR VIEWS, EACH ANSWERING A DIFFERENT QUESTION
 *
 *   Window totals            HOW MUCH   requests, errors, error rate, p50/95/99
 *   Per-minute timeline      WHEN       is it growing, steady, or already over?
 *   Per-endpoint breakdown   WHERE      is one path slow, or all of them?
 *   Sampled log lines        WHAT       what does the failure actually say?
 *
 * The last two were added after measurement, not intuition. Without the
 * endpoint breakdown, "the service is slow" and "one background job is slow
 * while users are fine" are identical evidence with opposite verdicts. Without
 * the timeline, a burst that stopped after sixty seconds is indistinguishable
 * from five minutes of steady failure — and a real classification was wrong for
 * exactly that reason before it existed.
 *
 * THE BUDGET, AND WHY IT IS SMALL
 * 8 signatures, 6 endpoints, 20 timeline minutes, 15 error lines, 8 healthy
 * lines, 240 chars per message. The aggregates carry the signal; the raw lines
 * exist to show the model what the failure looks like. Doubling these roughly
 * doubles input tokens for a marginal gain in evidence.
 *
 * TWO SAMPLING RULES THAT MATTER
 *
 *   sampleEvenly    spreads across time, so an incident's ARC is visible —
 *                   it starts, escalates, sometimes recovers, and a slice from
 *                   either end shows one phase and hides the rest.
 *
 *   sampleDiverse   groups by normalised message shape and allocates the
 *                   budget round-robin, rarest shape first. A line is
 *                   informative roughly in proportion to how RARE its shape
 *                   is: twenty copies of `GET /orders 200` say what one copy
 *                   says, while a single `v1.4.2 starting up` explains the
 *                   whole window. Uniform sampling dropped exactly that line
 *                   once, leaving a benign window no reader could have judged
 *                   correctly. That is why this function exists.
 *
 * COUPLING WORTH KNOWING
 * The `Service:` and `Triggers fired:` lines are parsed by the stub provider,
 * so their format is load-bearing beyond readability.
 */

import type { AnomalyTrigger, LogLevel } from "@obs/shared";
import { isErrorLevel, normalizeErrorSignature } from "@obs/shared";

/**
 * Context budget. These are small on purpose — the aggregates carry the signal
 * and the raw lines are there to show the model what the failure actually
 * looks like. Doubling them roughly doubles input tokens for a marginal gain
 * in evidence, which is the wrong trade on a free tier.
 */
export const contextBudget = {
  /** Distinct error signatures listed, most frequent first. */
  maxSignatures: 8,
  /** Endpoints listed, slowest first. Enough to show where latency is concentrated. */
  maxEndpoints: 6,
  /**
   * Minutes of per-minute detail. A merged anomaly can span far longer than the
   * detection window, and the most recent minutes are the ones that say whether
   * it is still happening — so when truncating, keep the tail.
   */
  maxTimelineMinutes: 20,
  /** Error/warn lines sampled across the window. */
  maxErrorLines: 15,
  /**
   * Healthy lines, which do two jobs. They provide contrast — a model reading
   * only failures assumes total outage, and successful requests in the same
   * window are what distinguish "degraded" from "down". They are also where
   * service narration lives: deploy banners, job start and finish lines, the
   * rare non-request entries that explain why a window looks the way it does.
   * The budget is larger than contrast alone would need, because the sampler
   * gives rare shapes priority and those lines are always rare.
   */
  maxHealthyLines: 8,
  /** Per-message cap. Stack traces are the reason this exists. */
  maxMessageChars: 240,
} as const;

export interface ContextLogLine {
  timestamp: Date;
  level: LogLevel;
  message: string;
  /**
   * Explicitly `| undefined`: metadata is open-ended by design, so a log entry
   * genuinely may not carry these, and `exactOptionalPropertyTypes` is on.
   */
  endpoint?: string | undefined;
  statusCode?: number | undefined;
}

export interface ContextSignature {
  signature: string;
  occurrences: number;
  sampleMessage: string;
}

export interface WindowMetrics {
  requestCount: number;
  errorCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/**
 * Per-minute detail across the window.
 *
 * The dimension everything else in the packet lacks. Totals say *how much*, the
 * endpoint breakdown says *where*, and neither says *when* — so a burst that
 * lasted sixty seconds and stopped is indistinguishable from steady failure for
 * five minutes. Those are different incidents, and one of them is usually not
 * an incident at all.
 *
 * This was measured, not assumed: a deploy restart that recovered inside its
 * window was classified as a high-severity incident because the evidence showed
 * errors spread across every endpoint with no indication they had already
 * stopped.
 */
export interface MinuteMetric {
  bucketStart: Date;
  requestCount: number;
  errorCount: number;
  p95Ms: number;
}

/**
 * Per-endpoint breakdown.
 *
 * A service-wide p95 is an average of very different things. When one path is
 * slow and the rest are fine, the aggregate says "everything is slow" and the
 * breakdown says "one background job is slow" — and those are different
 * incidents, or rather one incident and one non-incident. The rollup worker
 * already writes these rows; not reading them was leaving the evidence that
 * distinguishes the two cases on the floor.
 */
export interface EndpointMetric {
  endpoint: string;
  requestCount: number;
  errorCount: number;
  p95Ms: number;
}

export interface ClassificationInput {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: readonly AnomalyTrigger[];
  metrics: WindowMetrics;
  /** Chronological, one entry per minute of the window. */
  timeline: readonly MinuteMetric[];
  /** Slowest-first breakdown; empty when the service has only one path. */
  endpoints: readonly EndpointMetric[];
  signatures: readonly ContextSignature[];
  logLines: readonly ContextLogLine[];
  /** Total lines the sample was drawn from, so the model knows the scale. */
  totalLogLines: number;
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const clock = (date: Date): string => date.toISOString().slice(11, 19);

/**
 * Evenly spaced sample rather than the first or last n.
 *
 * An incident has a shape — it starts, escalates, and sometimes recovers.
 * Taking a slice from one end shows one phase of that and hides the rest.
 */
export function sampleEvenly<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];

  const step = items.length / limit;
  const sampled: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) sampled.push(item);
  }
  return sampled;
}

/**
 * Sample for variety first, volume second.
 *
 * Uniform sampling assumes every line is equally informative, and in a log
 * stream that is badly false: a line is informative roughly in proportion to
 * how *rare* its shape is. Twenty copies of `GET /orders 200` say exactly what
 * one copy says. A single `v1.4.2 starting up` explains the entire window.
 *
 * This was not a hypothetical. The first captured deploy-restart case dropped
 * its startup banner — one line among two thousand routine ones — leaving a
 * benign window that no reader, human or model, could have distinguished from
 * an outage. Volume had crowded out the only line that mattered.
 *
 * So lines are grouped by normalised message shape (the same collapsing the
 * error signatures use) and drawn round-robin across groups, evenly spaced
 * within each. Rare shapes are guaranteed a slot; common ones still fill
 * whatever is left, so the sample stays representative of what was happening.
 */
export function sampleDiverse<T>(
  items: readonly T[],
  limit: number,
  shapeOf: (item: T) => string,
): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const shape = shapeOf(item);
    const group = groups.get(shape);
    if (group) group.push(item);
    else groups.set(shape, [item]);
  }

  // Rarest shapes first, so a one-off line is never the one that gets cut.
  const ordered = [...groups.values()].sort((a, b) => a.length - b.length);

  /**
   * Hand out the budget a slot at a time, cycling through the shapes. Every
   * shape gets its first slot before any shape gets a second, which is what
   * guarantees the rare line survives; once the small groups are exhausted the
   * remaining slots fall through to the common ones, so the budget is always
   * spent in full.
   */
  const take = new Array<number>(ordered.length).fill(0);
  let remaining = limit;

  while (remaining > 0) {
    let allocated = false;
    for (let i = 0; i < ordered.length && remaining > 0; i += 1) {
      const group = ordered[i];
      if (group && take[i]! < group.length) {
        take[i]! += 1;
        remaining -= 1;
        allocated = true;
      }
    }
    // Every group is exhausted; the budget was larger than the input.
    if (!allocated) break;
  }

  // Even spacing within each shape, so a shape's own progression still shows.
  return ordered.flatMap((group, i) => sampleEvenly(group, take[i] ?? 0));
}

function describeTrigger(trigger: AnomalyTrigger): string {
  switch (trigger.kind) {
    case "error_rate_spike":
      return (
        `error_rate_spike: ${trigger.observedErrors} errors in the window against a ` +
        `baseline of ${trigger.baselineMean}/min (sd ${trigger.baselineStdDev}, z=${trigger.zScore})`
      );
    case "latency_jump":
      return (
        `latency_jump: ${trigger.metric} ${trigger.observedMs}ms against a baseline of ` +
        `${trigger.baselineMs}ms (${trigger.ratio}x)`
      );
    case "new_error_signature":
      return (
        `new_error_signature: "${trigger.signature}" occurred ${trigger.occurrences} times ` +
        `and appears nowhere in the baseline hour`
      );
  }
}

function formatLine(line: ContextLogLine): string {
  const parts = [clock(line.timestamp), line.level.toUpperCase()];
  if (line.endpoint) parts.push(line.endpoint);
  if (line.statusCode !== undefined) parts.push(String(line.statusCode));
  return `  ${parts.join(" ")} — ${truncate(line.message, contextBudget.maxMessageChars)}`;
}

/**
 * Render the evidence packet.
 *
 * The `Service:` and `Triggers fired:` lines are load-bearing beyond
 * readability — the stub provider parses them, so changing their shape means
 * updating `llm/providers/stub.ts` too.
 */
export function renderClassificationContext(input: ClassificationInput): string {
  const { metrics } = input;
  const windowMinutes = Math.max(
    1,
    Math.round((input.windowEnd.getTime() - input.windowStart.getTime()) / 60_000),
  );
  const errorRate =
    metrics.requestCount > 0
      ? ((metrics.errorCount / metrics.requestCount) * 100).toFixed(1)
      : "0.0";

  const sections: string[] = [];

  sections.push(
    [
      `Service: ${input.service}`,
      `Window: ${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()} (${windowMinutes} min)`,
      `Triggers fired: ${input.triggers.map((t) => t.kind).join(", ")}`,
    ].join("\n"),
  );

  sections.push(
    ["What the statistical detectors found:", ...input.triggers.map((t) => `- ${describeTrigger(t)}`)].join(
      "\n",
    ),
  );

  sections.push(
    [
      "Window totals:",
      `  requests ${metrics.requestCount} | errors ${metrics.errorCount} (${errorRate}%)`,
      `  latency p50 ${metrics.p50Ms}ms | p95 ${metrics.p95Ms}ms | p99 ${metrics.p99Ms}ms`,
    ].join("\n"),
  );

  if (input.timeline.length > 0) {
    const shown = input.timeline.slice(-contextBudget.maxTimelineMinutes);
    const truncated = input.timeline.length > shown.length;

    sections.push(
      [
        truncated
          ? `Per-minute detail (last ${shown.length} of ${input.timeline.length} minutes):`
          : `Per-minute detail (${shown.length} minutes):`,
        ...shown.map(
          (minute) =>
            `  ${clock(minute.bucketStart).slice(0, 5)}  ` +
            `${String(minute.requestCount).padStart(5)} req  ` +
            `${String(minute.errorCount).padStart(5)} err  ` +
            `p95 ${String(minute.p95Ms).padStart(5)}ms`,
        ),
      ].join("\n"),
    );
  }

  /**
   * Only worth the tokens when there is more than one path — with a single
   * endpoint this repeats the window totals in a wider format.
   */
  if (input.endpoints.length > 1) {
    const shown = [...input.endpoints]
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, contextBudget.maxEndpoints);

    sections.push(
      [
        "Latency by endpoint (slowest first):",
        ...shown.map(
          (endpoint) =>
            `  ${truncate(endpoint.endpoint || "(none)", 40).padEnd(24)} ` +
            `${String(endpoint.requestCount).padStart(6)} req  ` +
            `${String(endpoint.errorCount).padStart(4)} err  ` +
            `p95 ${endpoint.p95Ms}ms`,
        ),
      ].join("\n"),
    );
  }

  if (input.signatures.length > 0) {
    const shown = [...input.signatures]
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, contextBudget.maxSignatures);

    const header =
      input.signatures.length > shown.length
        ? `Error signatures (top ${shown.length} of ${input.signatures.length}):`
        : `Error signatures (${shown.length}):`;

    sections.push(
      [
        header,
        ...shown.flatMap((signature) => [
          `  ${signature.occurrences}x  ${truncate(signature.signature, contextBudget.maxMessageChars)}`,
          `        example: ${truncate(signature.sampleMessage, contextBudget.maxMessageChars)}`,
        ]),
      ].join("\n"),
    );
  }

  /**
   * Shape is the message with its variable detail stripped, so `Order 12778
   * not found` and `Order 44012 not found` are one shape. Endpoint and status
   * join the key because `GET /orders 200` and `POST /orders 201` are
   * genuinely different events sharing a message template.
   */
  const shapeOf = (line: ContextLogLine): string =>
    `${line.endpoint ?? ""} ${line.statusCode ?? ""} ${normalizeErrorSignature(line.message)}`;

  const errorLines = input.logLines.filter((line) => isErrorLevel(line.level));
  const healthyLines = input.logLines.filter((line) => !isErrorLevel(line.level));
  const sampled = [
    ...sampleDiverse(errorLines, contextBudget.maxErrorLines, shapeOf),
    ...sampleDiverse(healthyLines, contextBudget.maxHealthyLines, shapeOf),
  ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (sampled.length > 0) {
    sections.push(
      [
        `Log sample (${sampled.length} lines, evenly spaced, drawn from ${input.totalLogLines} in the window):`,
        ...sampled.map(formatLine),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
