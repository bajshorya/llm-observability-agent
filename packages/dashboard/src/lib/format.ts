/**
 * Presentation helpers shared by both pages. Pure, so the pages stay markup.
 */

import type { AnomalyTrigger, Severity } from "@obs/shared";

/**
 * Severity as a CSS class, with `dismissed` treated as its own band rather than
 * as `low`.
 *
 * A window Tier 2 ruled benign and one it ruled genuinely minor are different
 * findings, and colouring them the same would erase the distinction the entire
 * second tier exists to draw.
 */
export function severityClass(severity: Severity | null, isRealIncident: boolean | null): string {
  if (isRealIncident === false) return "dismissed";
  return severity ?? "unclassified";
}

export function formatWindow(start: Date, end: Date): string {
  const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
  return `${start.toISOString().replace("T", " ").slice(0, 16)}Z · ${minutes} min`;
}

export function formatAge(then: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One trigger as a sentence, carrying its own evidence.
 *
 * The numbers are the point. "error_rate_spike" alone is an assertion; the
 * observed count against the baseline and its z-score is a claim a reader can
 * disagree with, which is the standard the rest of this project holds itself to.
 */
export function describeTrigger(trigger: AnomalyTrigger): string {
  switch (trigger.kind) {
    case "error_rate_spike":
      return `${trigger.observedErrors} errors against a baseline of ${trigger.baselineMean}/min (sd ${trigger.baselineStdDev}, z=${trigger.zScore})`;
    case "latency_jump":
      return `${trigger.metric} ${trigger.observedMs}ms against a baseline of ${trigger.baselineMs}ms (${trigger.ratio}x)`;
    case "new_error_signature":
      return `"${trigger.signature}" ×${trigger.occurrences}, absent from the baseline hour`;
  }
}

export function tokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return "not reported";
  return `${input ?? "?"} in / ${output ?? "?"} out`;
}
