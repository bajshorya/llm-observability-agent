import type { AnomalyTrigger, LogLevel } from "@obs/shared";
import { isErrorLevel } from "@obs/shared";

/**
 * Building the classifier's evidence packet.
 *
 * A five-minute window on a busy service is tens of thousands of log lines.
 * Sending them is impossible, and sending the first N is worse than useless —
 * the first N lines of an incident are the healthy traffic that preceded it.
 *
 * So this file is a summariser, and it is pure: same window in, same prompt
 * out, no clock and no database. That is what makes the prompt reproducible,
 * which is what makes a regression in classification quality attributable to
 * the prompt rather than to whatever the sampler happened to pick that run.
 */

/**
 * Context budget. These are small on purpose — the aggregates carry the signal
 * and the raw lines are there to show the model what the failure actually
 * looks like. Doubling them roughly doubles input tokens for a marginal gain
 * in evidence, which is the wrong trade on a free tier.
 */
export const contextBudget = {
  /** Distinct error signatures listed, most frequent first. */
  maxSignatures: 8,
  /** Error/warn lines sampled across the window. */
  maxErrorLines: 15,
  /**
   * Healthy lines, for contrast. Without any, a model reading only failures
   * tends to assume total outage; a few successful requests in the same window
   * are what distinguish "degraded" from "down".
   */
  maxHealthyLines: 5,
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

export interface ClassificationInput {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: readonly AnomalyTrigger[];
  metrics: WindowMetrics;
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

  const errorLines = input.logLines.filter((line) => isErrorLevel(line.level));
  const healthyLines = input.logLines.filter((line) => !isErrorLevel(line.level));
  const sampled = [
    ...sampleEvenly(errorLines, contextBudget.maxErrorLines),
    ...sampleEvenly(healthyLines, contextBudget.maxHealthyLines),
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
