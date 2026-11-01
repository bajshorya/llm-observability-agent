/**
 * Alerting — the decisions, with no network and no database.
 *
 * WHAT THIS FILE DOES
 * Decides whether an anomaly deserves an alert, and for which reason, and turns
 * it into the text a person reads at 3am. `notify.ts` owns persistence and the
 * HTTP POST; everything here is a pure function of the anomaly row, which is
 * why it can be tested on plain objects.
 *
 * THE TWO REASONS, AND WHY THERE ARE NOT MORE
 *
 *   incident   Tier 2 read the window and judged it real, at or above the
 *              configured severity. This is the alert the two-tier design
 *              exists to make quiet: a deploy restart trips the same detectors
 *              as an outage, and only the incident reaches a phone.
 *
 *   silence    Tier 1 alone saw a busy service stop logging. No model is
 *              involved because there is nothing to read — and waiting for one
 *              would mean the worst incident there is (a dead service) pages
 *              last, or never.
 *
 * Deliberately NOT a reason: "Tier 1 fired". Alerting on raw statistics is the
 * noisy system this project is built to replace. If no model is configured,
 * the stub classifier still runs for free and scores the statistics, so the
 * loop degrades to a statistical pager rather than to silence.
 *
 * NOTHING HERE SUGGESTS ACTING
 * An alert links to the reasoning trace. It never carries a fix to apply; the
 * suggested fix lives on the dashboard behind the human gate, as everywhere
 * else.
 */

import type { AnomalyTrigger, Severity } from "@obs/shared";
import { describeTrigger } from "../classification/context";

export type AlertReason = "incident" | "silence";
export type AlertChannel = "slack" | "webhook" | "console";

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The anomaly fields alerting reads. A subset of the row, so tests stay small. */
export interface AlertableAnomaly {
  id: string;
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: AnomalyTrigger[];
  severity: Severity | null;
  summary: string | null;
  isRealIncident: boolean | null;
}

/** The most recent correlation, when one exists by the time the alert goes. */
export interface AlertCorrelation {
  suspectedCommitSha: string | null;
  confidence: number;
}

export interface AlertPolicy {
  minSeverity: Severity;
}

/** Which reasons apply to this anomaly right now. Usually zero or one. */
export function alertReasonsFor(anomaly: AlertableAnomaly, policy: AlertPolicy): AlertReason[] {
  const reasons: AlertReason[] = [];

  if (
    anomaly.isRealIncident === true &&
    anomaly.severity !== null &&
    SEVERITY_RANK[anomaly.severity] >= SEVERITY_RANK[policy.minSeverity]
  ) {
    reasons.push("incident");
  }

  if (anomaly.triggers.some((trigger) => trigger.kind === "service_silent")) {
    reasons.push("silence");
  }

  return reasons;
}

/** Past attempts for one (anomaly, reason, channel). */
export interface AttemptRecord {
  succeeded: boolean;
}

/**
 * A webhook that is down is retried on later ticks, but not forever: a URL
 * that has failed three times is misconfigured, not flaky, and retrying it
 * every thirty seconds only fills the table.
 */
export const MAX_ALERT_ATTEMPTS = 3;

export function shouldAttempt(previous: readonly AttemptRecord[]): boolean {
  if (previous.some((attempt) => attempt.succeeded)) return false;
  return previous.length < MAX_ALERT_ATTEMPTS;
}

export interface AlertMessage {
  reason: AlertReason;
  anomalyId: string;
  service: string;
  severity: Severity | null;
  title: string;
  /** Plain text, several lines. Slack renders it as mrkdwn. */
  text: string;
  url: string;
}

const iso = (date: Date) => `${date.toISOString().replace("T", " ").slice(0, 16)}Z`;

export function buildAlertMessage(
  anomaly: AlertableAnomaly,
  reason: AlertReason,
  options: { dashboardUrl: string; correlation?: AlertCorrelation | null },
): AlertMessage {
  const url = `${options.dashboardUrl.replace(/\/$/, "")}/anomaly/${anomaly.id}`;

  if (reason === "silence") {
    const silence = anomaly.triggers.find((trigger) => trigger.kind === "service_silent");
    const detail = silence ? describeTrigger(silence) : "service_silent";
    return {
      reason,
      anomalyId: anomaly.id,
      service: anomaly.service,
      severity: anomaly.severity,
      title: `${anomaly.service} has stopped logging`,
      text: [
        `*${anomaly.service} has stopped logging*`,
        detail,
        "Detected by statistics alone — silence has nothing for a model to read.",
        url,
      ].join("\n"),
      url,
    };
  }

  const severity = (anomaly.severity ?? "unrated").toUpperCase();
  const lines = [
    `*${severity} — ${anomaly.service}* (${iso(anomaly.windowStart)} to ${iso(anomaly.windowEnd)})`,
    anomaly.summary ?? "No summary.",
    ...anomaly.triggers.map((trigger) => `• ${describeTrigger(trigger)}`),
  ];

  const correlation = options.correlation;
  if (correlation) {
    lines.push(
      correlation.suspectedCommitSha
        ? `Suspected commit: ${correlation.suspectedCommitSha.slice(0, 10)} (confidence ${correlation.confidence.toFixed(2)})`
        : "No recent commit explains this.",
    );
  }
  lines.push(url);

  return {
    reason,
    anomalyId: anomaly.id,
    service: anomaly.service,
    severity: anomaly.severity,
    title: `${severity} incident on ${anomaly.service}`,
    text: lines.join("\n"),
    url,
  };
}

/** Slack incoming-webhook body. `text` alone is enough, and renders mrkdwn. */
export function toSlackPayload(message: AlertMessage): { text: string } {
  return { text: message.text };
}

/** Generic webhook body: the structured fields, so a receiver need not parse text. */
export function toWebhookPayload(message: AlertMessage): AlertMessage {
  return message;
}
