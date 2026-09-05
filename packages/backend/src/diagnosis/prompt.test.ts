/**
 * Tests for the root-cause prompt.
 *
 * Guards discipline, not wording — the same regression the correlator prompt
 * is guarded against, and for the same reason: putting an example in the
 * prompt raises the score and invalidates every number produced afterwards.
 *
 * `CLAUDE.md` states the rule. A rule that lives only in a document survives
 * exactly as long as the next person who has not read it.
 */

import { describe, expect, it } from "vitest";
import { ROOT_CAUSE_SYSTEM_PROMPT } from "./prompt";

const FIXTURE_LEAKS = [
  "toFixed",
  "pricing.js",
  "formatPrice",
  "formatDiscountedPrice",
  "discounted_cents",
  "discounted_total",
  "orders-api",
  "rateLimit.js",
  "refunds.js",
  "marketplace",
];

describe("ROOT_CAUSE_SYSTEM_PROMPT", () => {
  it("names nothing from the fixture repository", () => {
    for (const leak of FIXTURE_LEAKS) {
      expect(
        ROOT_CAUSE_SYSTEM_PROMPT.toLowerCase(),
        `the prompt contains "${leak}", which is from the fixture the eval scores against`,
      ).not.toContain(leak.toLowerCase());
    }
  });

  it("contains no commit sha", () => {
    const shaLike = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;
    expect(shaLike.test(ROOT_CAUSE_SYSTEM_PROMPT)).toBe(false);
  });

  it("asks for every field the schema requires", () => {
    for (const field of ["explainsTheFailure", "rootCause", "suggestedFix", "confidence"]) {
      expect(ROOT_CAUSE_SYSTEM_PROMPT).toContain(field);
    }
  });

  it("tells the model it may disagree with the correlation it was handed", () => {
    // The structural escape hatch, and the reason `explainsTheFailure` exists.
    // Phase 3 established that a model with no way to decline fabricates.
    expect(ROOT_CAUSE_SYSTEM_PROMPT).toContain("does not oblige you to agree");
  });

  it("rules out the unreviewable fixes by name", () => {
    // "Add error handling" is true of almost all code and actionable for none
    // of it. Naming the failure mode is what stops it.
    const lower = ROOT_CAUSE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("add error handling");
    expect(lower).toContain("actionable for none");
  });

  it("says nothing is applied", () => {
    // hypotheses.applied defaults to false and no code writes it. Telling the
    // model changes what it writes, toward something a reviewer can judge.
    expect(ROOT_CAUSE_SYSTEM_PROMPT).toContain("Nothing you write is applied");
  });
});
