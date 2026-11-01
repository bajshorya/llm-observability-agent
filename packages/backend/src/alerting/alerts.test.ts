/**
 * Alert decisions, on plain objects.
 *
 * The properties that matter: a dismissed window never pages (that is the
 * whole two-tier claim), silence pages with no model involved, a success is
 * never repeated, and a dead webhook is not retried forever.
 */

import { describe, expect, it } from "vitest";
import type { AnomalyTrigger } from "@obs/shared";
import {
  alertReasonsFor,
  buildAlertMessage,
  MAX_ALERT_ATTEMPTS,
  shouldAttempt,
  toSlackPayload,
  type AlertableAnomaly,
} from "./alerts";

const spike: AnomalyTrigger = {
  kind: "error_rate_spike",
  service: "orders-api",
  observedErrors: 336,
  baselineMean: 0.53,
  baselineStdDev: 0.79,
  zScore: 84.26,
};

const silent: AnomalyTrigger = {
  kind: "service_silent",
  service: "orders-api",
  lastSeenAt: "2026-11-01T11:48:00.000Z",
  silentMinutes: 12,
  baselineLinesPerMinute: 40,
};

const base: AlertableAnomaly = {
  id: "677a9a91-0000-0000-0000-000000000000",
  service: "orders-api",
  windowStart: new Date("2026-11-01T11:55:00Z"),
  windowEnd: new Date("2026-11-01T12:00:00Z"),
  triggers: [spike],
  severity: null,
  summary: null,
  isRealIncident: null,
};

const policy = { minSeverity: "high" as const };

describe("alertReasonsFor", () => {
  it("does not alert on an anomaly no model has judged", () => {
    expect(alertReasonsFor(base, policy)).toEqual([]);
  });

  it("alerts on a real incident at or above the threshold", () => {
    expect(alertReasonsFor({ ...base, severity: "critical", isRealIncident: true }, policy)).toEqual(["incident"]);
    expect(alertReasonsFor({ ...base, severity: "high", isRealIncident: true }, policy)).toEqual(["incident"]);
  });

  it("does not alert on a real incident below the threshold", () => {
    expect(alertReasonsFor({ ...base, severity: "medium", isRealIncident: true }, policy)).toEqual([]);
  });

  it("never alerts on a dismissed window, whatever its severity", () => {
    // The deploy-restart case: identical statistics to an outage.
    expect(alertReasonsFor({ ...base, severity: "critical", isRealIncident: false }, policy)).toEqual([]);
  });

  it("alerts on silence with no model verdict at all", () => {
    expect(alertReasonsFor({ ...base, triggers: [silent] }, policy)).toEqual(["silence"]);
  });

  it("gives both reasons when an incident is followed by silence", () => {
    const crashed = { ...base, triggers: [spike, silent], severity: "critical" as const, isRealIncident: true };
    expect(alertReasonsFor(crashed, policy)).toEqual(["incident", "silence"]);
  });
});

describe("shouldAttempt", () => {
  it("attempts when nothing has been tried", () => {
    expect(shouldAttempt([])).toBe(true);
  });

  it("never repeats a success", () => {
    expect(shouldAttempt([{ succeeded: false }, { succeeded: true }])).toBe(false);
  });

  it("retries a failure, up to the cap", () => {
    expect(shouldAttempt([{ succeeded: false }])).toBe(true);
    const exhausted = Array.from({ length: MAX_ALERT_ATTEMPTS }, () => ({ succeeded: false }));
    expect(shouldAttempt(exhausted)).toBe(false);
  });
});

describe("buildAlertMessage", () => {
  const incident = {
    ...base,
    severity: "critical" as const,
    isRealIncident: true,
    summary: "orders-api is returning 500s from a new TypeError.",
  };

  it("carries severity, summary, the detector evidence and a link", () => {
    const message = buildAlertMessage(incident, "incident", { dashboardUrl: "http://localhost:3000/" });
    expect(message.title).toBe("CRITICAL incident on orders-api");
    expect(message.text).toContain("orders-api is returning 500s");
    expect(message.text).toContain("z=84.26");
    expect(message.url).toBe("http://localhost:3000/anomaly/677a9a91-0000-0000-0000-000000000000");
  });

  it("names the blamed commit when correlation has already run", () => {
    const message = buildAlertMessage(incident, "incident", {
      dashboardUrl: "http://x",
      correlation: { suspectedCommitSha: "0c701a0bcc1234567", confidence: 0.85 },
    });
    expect(message.text).toContain("Suspected commit: 0c701a0bcc (confidence 0.85)");
  });

  it("says so when correlation declined", () => {
    const message = buildAlertMessage(incident, "incident", {
      dashboardUrl: "http://x",
      correlation: { suspectedCommitSha: null, confidence: 0.2 },
    });
    expect(message.text).toContain("No recent commit explains this.");
  });

  it("says a silence alert involved no model", () => {
    const message = buildAlertMessage({ ...base, triggers: [silent] }, "silence", { dashboardUrl: "http://x" });
    expect(message.title).toBe("orders-api has stopped logging");
    expect(message.text).toContain("no log lines for 12 minutes");
    expect(message.text).toContain("statistics alone");
  });

  it("never carries a fix", () => {
    const message = buildAlertMessage(incident, "incident", { dashboardUrl: "http://x" });
    expect(toSlackPayload(message)).toEqual({ text: message.text });
    expect(message.text.toLowerCase()).not.toContain("fix");
  });
});
