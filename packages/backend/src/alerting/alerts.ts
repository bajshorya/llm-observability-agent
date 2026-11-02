/**
 * Alerting — the decisions, with no network and no database.
 *
 * WHAT THIS FILE DOES
 * Decides whether an anomaly deserves an alert, and for which reason, and turns
 * it into the text a person reads at 3am. `notify.ts` owns persistence and the
 * HTTP POST; everything here is a pure function of the anomaly row, which is
 * why it can be tested on plain objects.
 *
 * THE THREE REASONS, AND WHY THERE ARE NOT MORE
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
 *   injection  The evidence packet contained text addressed to the model
 *              (classification/injection.ts) and the model's verdict would
 *              not page. That verdict is precisely what an injection tries to
 *              produce, so it does not get to keep the window quiet. Decided
 *              by a deterministic scan, never by the model under attack.
 *
 * Every string an attacker can influence — the model's summary, error
 * signatures, the flagged text — is escaped before it reaches Slack.
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

export type AlertReason = "incident" | "silence" | "injection";
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
  /** Set by the injection guard before Tier 2 calls a model. Null until scanned. */
  injectionSuspected: boolean | null;
  injectionEvidence: string | null;
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

  const incident =
    anomaly.isRealIncident === true &&
    anomaly.severity !== null &&
    SEVERITY_RANK[anomaly.severity] >= SEVERITY_RANK[policy.minSeverity];
  if (incident) reasons.push("incident");

  /**
   * The evidence contained text addressed to the model, and the model's
   * verdict would not page: dismissed, rated below the threshold, or no
   * verdict at all because the call failed. That verdict is exactly what an
   * injection is trying to produce, so it is not trusted to keep this quiet.
   * When the model pages anyway, the incident alert carries the warning
   * instead of sending a second page.
   */
  if (anomaly.injectionSuspected === true && !incident) reasons.push("injection");

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

  if (reason === "injection") {
    const verdict =
      anomaly.isRealIncident === null
        ? "no verdict yet"
        : `${anomaly.isRealIncident ? "incident" : "dismissed"}, ${anomaly.severity ?? "unrated"}`;
    return {
      reason,
      anomalyId: anomaly.id,
      service: anomaly.service,
      severity: anomaly.severity,
      title: `Possible prompt injection on ${anomaly.service}`,
      text: [
        `*Possible prompt injection — ${anomaly.service}* (${iso(anomaly.windowStart)} to ${iso(anomaly.windowEnd)})`,
        "Log text in this window is addressed to the automated classifier. Its verdict " +
          `(${verdict}) is not trusted to keep this quiet, so a human is being asked instead.`,
        `Flagged text: ${quoteUntrusted(anomaly.injectionEvidence ?? "(not recorded)")}`,
        ...anomaly.triggers.map((trigger) => `• ${describeTrigger(trigger)}`),
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

  if (anomaly.injectionSuspected === true) {
    lines.push(
      `Warning: log text in this window is addressed to the classifier — ${quoteUntrusted(
        anomaly.injectionEvidence ?? "(not recorded)",
      )}`,
    );
  }

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

/**
 * Attacker-controlled text, shown as a quotation: bounded, on one line, and
 * with backticks replaced so it cannot open or close a code span.
 */
function quoteUntrusted(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `"${flat.length > 200 ? `${flat.slice(0, 199)}…` : flat}"`;
}

/**
 * Slack mrkdwn treats `<…>` as control syntax: `<!channel>` pings everyone and
 * `<https://evil.example|Open runbook>` is a link whose target is hidden. The
 * text of an alert carries a model's summary and raw error signatures, and
 * both come from logs an attacker can write to, so `&`, `<` and `>` are
 * escaped as Slack's documentation requires. Our own formatting (`*bold*`,
 * bullets, a bare URL) does not use them.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Slack incoming-webhook body. `text` alone renders mrkdwn. Unfurling is off:
 * a URL inside attacker-written text would otherwise be fetched by Slack and
 * previewed in the channel.
 */
export function toSlackPayload(message: AlertMessage): {
  text: string;
  unfurl_links: false;
  unfurl_media: false;
} {
  return { text: escapeSlack(message.text), unfurl_links: false, unfurl_media: false };
}

/**
 * Generic webhook body: the structured fields, so a receiver need not parse
 * text. Not escaped — JSON carries strings safely, and how to render them is
 * the receiver's decision. A receiver that renders `text` as markup must treat
 * it as untrusted, because it is.
 */
export function toWebhookPayload(message: AlertMessage): AlertMessage {
  return message;
}
