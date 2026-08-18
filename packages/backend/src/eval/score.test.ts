/**
 * Tests for the eval's scoring rules.
 *
 * WHAT THIS FILE COVERS
 * `checkGrounding`, `severityDistance`, `scoreCase` and `summarise` — the pure
 * rules that turn a model's answers into a scorecard. No provider is called;
 * classifications are supplied directly as fixtures.
 *
 * THE TEST THAT MATTERS MOST
 * "rejects a path that appears nowhere — the observed failure" encodes a real
 * hallucination verbatim. A model answered `/orders/checkout path` for a service
 * whose endpoints are `/orders`, `/orders/:id` and `/orders/:id/refund`. Verdict
 * right, severity right, location invented. The grounding check exists because
 * of that answer, and this test is what keeps it working.
 *
 * WHAT ELSE IS PINNED DOWN
 *   - Declining ("unknown") counts as GROUNDED, not as a failure. Scoring it
 *     otherwise would push the prompt toward confident guessing.
 *   - Severity is scored within one band; more than one band apart fails.
 *   - `summarise` reports dismissals and confirmations SEPARATELY. The test
 *     constructs the exact pathology this guards against — a model right on
 *     every incident and wrong on every benign case — and asserts the two
 *     numbers stay distinguishable. Blended, that reads as mediocre; split, it
 *     reads as "not judging, just defaulting".
 *   - Failed calls are counted apart from wrong answers, so quota exhaustion
 *     can never masquerade as bad judgement.
 */

import { describe, expect, it } from "vitest";
import type { Classification } from "@obs/shared";
import type { GoldenCase } from "./cases";
import { checkGrounding } from "./grounding";
import { scoreCase, severityDistance, summarise, type CaseScore } from "./score";

const CONTEXT = [
  "Service: orders-api",
  "Triggers fired: error_rate_spike",
  "Log sample:",
  "  12:29:24 ERROR /orders/:id/refund 500 — TypeError: Cannot read properties of null",
  "  12:29:25 INFO /orders 200 — GET /orders 200",
  "  12:30:04 WARN — Upstream timeout contacting payments-service after 3000ms",
].join("\n");

describe("checkGrounding", () => {
  it("accepts a path that appears in the evidence", () => {
    expect(checkGrounding("POST /orders checkout flow", CONTEXT).grounded).toBe(true);
  });

  it("rejects a path that appears nowhere — the observed failure", () => {
    // llama3.2 answered this for a service whose endpoints are /orders,
    // /orders/:id and /orders/:id/refund. Verdict right, location invented.
    const result = checkGrounding("/orders/checkout path", CONTEXT);

    expect(result.grounded).toBe(false);
    expect(result.reason).toContain("/orders/checkout");
  });

  it("treats declining to answer as grounded, not as a failure", () => {
    // The prompt offers "unknown" deliberately; taking it is correct behaviour.
    expect(checkGrounding("unknown", CONTEXT).grounded).toBe(true);
    expect(checkGrounding("  ", CONTEXT).grounded).toBe(true);
  });

  it("accepts prose whose terms appear in the evidence", () => {
    expect(checkGrounding("payments-service upstream timeouts", CONTEXT).grounded).toBe(true);
  });

  it("rejects prose invented wholesale", () => {
    expect(checkGrounding("kafka consumer lag on billing", CONTEXT).grounded).toBe(false);
  });

  it("ignores trailing punctuation on a path", () => {
    expect(checkGrounding("/orders/:id/refund.", CONTEXT).grounded).toBe(true);
  });
});

describe("severityDistance", () => {
  it("is zero for a match and grows across bands", () => {
    expect(severityDistance("high", "high")).toBe(0);
    expect(severityDistance("high", "critical")).toBe(1);
    expect(severityDistance("low", "critical")).toBe(3);
  });
});

function makeCase(overrides: Partial<GoldenCase["expect"]> = {}): GoldenCase {
  return {
    name: "new-error",
    scenario: "new-error",
    capturedAt: "2026-08-11T00:00:00.000Z",
    expect: {
      isRealIncident: true,
      severity: "critical",
      note: "a novel TypeError returning 500s",
      ...overrides,
    },
    context: CONTEXT,
  };
}

function score(actual: Partial<Classification>, golden = makeCase()): CaseScore {
  return scoreCase({
    golden,
    actual: {
      severity: "critical",
      summary: "Checkout is failing.",
      isRealIncident: true,
      affectedArea: "POST /orders",
      ...actual,
    },
    latencyMs: 100,
    repairAttempts: 0,
    inputTokens: 500,
    outputTokens: 50,
  });
}

describe("scoreCase", () => {
  it("marks a matching verdict and severity correct", () => {
    const result = score({});

    expect(result.verdictCorrect).toBe(true);
    expect(result.severityExact).toBe(true);
    expect(result.grounding.grounded).toBe(true);
  });

  it("accepts a severity one band off but records it as inexact", () => {
    const result = score({ severity: "high" });

    expect(result.severityWithinOne).toBe(true);
    expect(result.severityExact).toBe(false);
  });

  it("fails a severity more than one band off", () => {
    expect(score({ severity: "low" }).severityWithinOne).toBe(false);
  });

  it("catches a benign window called an incident", () => {
    const benign = makeCase({ isRealIncident: false, severity: "low" });
    const result = score({ isRealIncident: true, severity: "critical" }, benign);

    expect(result.benignCase).toBe(true);
    expect(result.verdictCorrect).toBe(false);
  });
});

describe("summarise", () => {
  const benignCase = makeCase({ isRealIncident: false, severity: "low" });

  it("reports dismissals and confirmations separately", () => {
    // Both verdicts wrong in the same direction would otherwise average out to
    // a number that hides which half the model is failing on.
    const scores = [
      score({}),
      score({ isRealIncident: true, severity: "critical" }, benignCase),
    ];

    const summary = summarise(scores, 0);

    expect(summary.incidents).toEqual({ correct: 1, total: 1 });
    expect(summary.dismissals).toEqual({ correct: 0, total: 1 });
    expect(summary.verdictCorrect).toBe(1);
  });

  it("counts failed calls separately from wrong answers", () => {
    const summary = summarise([score({})], 2);

    expect(summary.total).toBe(1);
    expect(summary.failures).toBe(2);
  });

  it("totals cost across the run", () => {
    const summary = summarise([score({}), score({})], 0);

    expect(summary.totalInputTokens).toBe(1000);
    expect(summary.meanLatencyMs).toBe(100);
  });
});
