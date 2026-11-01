/**
 * Alerting — persistence and delivery.
 *
 * WHAT THIS FILE DOES
 * Finds recent anomalies that deserve an alert, sends each to every configured
 * channel at most once, and records every attempt in `alerts`. The decisions
 * themselves are in `alerts.ts`, which is pure.
 *
 * CHANNELS
 * `SLACK_WEBHOOK_URL` and `ALERT_WEBHOOK_URL`, either or both. With neither set
 * the channel is `console`: the alert is printed and recorded, so the loop can
 * be watched working before anyone has created a webhook.
 *
 * IDEMPOTENT BY CONSTRUCTION
 * A successful row for (anomaly, reason, channel) means never again. That is
 * what lets `pnpm watch` call this every thirty seconds — and lets a sustained
 * incident, which extends the same anomaly row on every tick, page once.
 *
 * A BOUNDED LOOKBACK
 * Only anomalies detected in the last `maxAgeMinutes` are considered. Without
 * it, adding a Slack webhook to a database with a month of history would post
 * a month of incidents in one go. An alert about something six hours old is a
 * report, and the dashboard is the place for reports.
 *
 * NO MODEL CALLS
 * Alerting reads what earlier stages wrote. It never classifies, so it never
 * spends quota — an unclassified anomaly simply has not earned an incident
 * alert yet.
 */

import { desc, gte, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { alerts, anomalies, correlations } from "../db/schema";
import { env } from "../env";
import {
  alertReasonsFor,
  buildAlertMessage,
  shouldAttempt,
  toSlackPayload,
  toWebhookPayload,
  type AlertChannel,
  type AlertCorrelation,
  type AlertMessage,
  type AlertReason,
  type AttemptRecord,
} from "./alerts";

const SEND_TIMEOUT_MS = 10_000;

export interface AlertTarget {
  channel: AlertChannel;
  url: string | null;
}

/** The channels configured in the environment, or `console` when there are none. */
export function configuredTargets(): AlertTarget[] {
  const targets: AlertTarget[] = [];
  if (env.SLACK_WEBHOOK_URL) targets.push({ channel: "slack", url: env.SLACK_WEBHOOK_URL });
  if (env.ALERT_WEBHOOK_URL) targets.push({ channel: "webhook", url: env.ALERT_WEBHOOK_URL });
  if (targets.length === 0) targets.push({ channel: "console", url: null });
  return targets;
}

export interface AlertOutcome {
  anomalyId: string;
  reason: AlertReason;
  channel: AlertChannel;
  status: "sent" | "failed" | "dry-run";
  message: AlertMessage;
  error?: string;
}

export interface SendAlertsOptions {
  /** Print what would be sent; send and record nothing. */
  dryRun?: boolean;
  maxAgeMinutes?: number;
  now?: Date;
  targets?: AlertTarget[];
}

async function deliver(target: AlertTarget, message: AlertMessage): Promise<void> {
  if (target.channel === "console" || target.url === null) {
    console.log(`\n[alert] ${message.title}\n${message.text}\n`);
    return;
  }

  const body = target.channel === "slack" ? toSlackPayload(message) : toWebhookPayload(message);
  const response = await fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

export async function sendPendingAlerts(options: SendAlertsOptions = {}): Promise<AlertOutcome[]> {
  const now = options.now ?? new Date();
  const maxAgeMinutes = options.maxAgeMinutes ?? 360;
  const targets = options.targets ?? configuredTargets();
  const since = new Date(now.getTime() - maxAgeMinutes * 60_000);

  const recent = await db
    .select({
      id: anomalies.id,
      service: anomalies.service,
      windowStart: anomalies.windowStart,
      windowEnd: anomalies.windowEnd,
      triggers: anomalies.triggers,
      severity: anomalies.severity,
      summary: anomalies.summary,
      isRealIncident: anomalies.isRealIncident,
    })
    .from(anomalies)
    .where(gte(anomalies.detectedAt, since))
    .orderBy(anomalies.detectedAt);

  const policy = { minSeverity: env.ALERT_MIN_SEVERITY };
  const due = recent
    .map((anomaly) => ({ anomaly, reasons: alertReasonsFor(anomaly, policy) }))
    .filter((entry) => entry.reasons.length > 0);
  if (due.length === 0) return [];

  const ids = due.map((entry) => entry.anomaly.id);

  const attemptRows = await db
    .select({
      anomalyId: alerts.anomalyId,
      reason: alerts.reason,
      channel: alerts.channel,
      succeeded: alerts.succeeded,
    })
    .from(alerts)
    .where(inArray(alerts.anomalyId, ids));

  const attempts = new Map<string, AttemptRecord[]>();
  for (const row of attemptRows) {
    const key = `${row.anomalyId}|${row.reason}|${row.channel}`;
    attempts.set(key, [...(attempts.get(key) ?? []), { succeeded: row.succeeded }]);
  }

  // Newest correlation per anomaly, so an alert that goes out late can say
  // which commit was blamed. Most incident alerts go before correlation runs.
  const correlationRows = await db
    .select({
      anomalyId: correlations.anomalyId,
      suspectedCommitSha: correlations.suspectedCommitSha,
      confidence: correlations.confidence,
    })
    .from(correlations)
    .where(inArray(correlations.anomalyId, ids))
    .orderBy(desc(correlations.createdAt));
  const correlationFor = new Map<string, AlertCorrelation>();
  for (const row of correlationRows) {
    if (!correlationFor.has(row.anomalyId)) correlationFor.set(row.anomalyId, row);
  }

  const outcomes: AlertOutcome[] = [];

  for (const { anomaly, reasons } of due) {
    for (const reason of reasons) {
      const message = buildAlertMessage(anomaly, reason, {
        dashboardUrl: env.DASHBOARD_URL,
        correlation: correlationFor.get(anomaly.id) ?? null,
      });

      for (const target of targets) {
        const key = `${anomaly.id}|${reason}|${target.channel}`;
        if (!shouldAttempt(attempts.get(key) ?? [])) continue;

        if (options.dryRun) {
          outcomes.push({ anomalyId: anomaly.id, reason, channel: target.channel, status: "dry-run", message });
          continue;
        }

        try {
          await deliver(target, message);
          await db.insert(alerts).values({
            anomalyId: anomaly.id,
            reason,
            channel: target.channel,
            succeeded: true,
          });
          outcomes.push({ anomalyId: anomaly.id, reason, channel: target.channel, status: "sent", message });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          await db.insert(alerts).values({
            anomalyId: anomaly.id,
            reason,
            channel: target.channel,
            succeeded: false,
            error: text,
          });
          outcomes.push({
            anomalyId: anomaly.id,
            reason,
            channel: target.channel,
            status: "failed",
            message,
            error: text,
          });
        }
      }
    }
  }

  return outcomes;
}
