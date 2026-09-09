/**
 * Tests for daily-quota detection.
 *
 * The two free-tier quotas produce near-identical 429s and differ only by the
 * limit named in the message. Getting this wrong in either direction is
 * expensive: treat a per-minute refusal as fatal and a run aborts when waiting
 * would have fixed it; treat a daily one as transient and the run spends
 * minutes waiting for a window that never opens. Both were observed.
 */

import { describe, expect, it } from "vitest";
import { isQuotaExhausted, skipRemaining } from "./run";

const quota = (limit: number): Error =>
  new Error(
    `gemini: HTTP 429 — {"error":{"code":429,"message":"You exceeded your current quota. ` +
      `\\n* Quota exceeded for metric: generativelanguage.googleapis.com/` +
      `generate_content_free_tier_requests, limit: ${limit}, model: gemini-3.5-flash` +
      `\\nPlease retry in 42.2s.","status":"RESOURCE_EXHAUSTED"}}`,
  );

describe("isQuotaExhausted", () => {
  it("treats the daily limit as exhausted", () => {
    expect(isQuotaExhausted(quota(20))).toBe(true);
  });

  it("does not treat the per-minute limit as exhausted", () => {
    // By the time this reaches the runner the transport has already waited it
    // out once; aborting here would throw away a run that could continue.
    expect(isQuotaExhausted(quota(5))).toBe(false);
  });

  it("ignores failures that are not 429s", () => {
    expect(isQuotaExhausted(new Error("gemini: HTTP 500 — internal"))).toBe(false);
    expect(isQuotaExhausted(new Error("network unreachable"))).toBe(false);
  });

  it("does not fire on a 429 with no limit named", () => {
    // Another provider's 429 says nothing about which quota. Treat it as
    // transient rather than aborting a whole run on a guess.
    expect(isQuotaExhausted(new Error("nvidia: HTTP 429 — too many requests"))).toBe(false);
  });

  it("handles a non-Error being thrown", () => {
    expect(isQuotaExhausted("HTTP 429 limit: 20")).toBe(true);
  });
});

describe("skipRemaining", () => {
  const cases = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("records the cases after the failure, not the failure itself", () => {
    const skipped = skipRemaining(cases, 1);

    expect(skipped.map((s) => s.name)).toEqual(["b", "c"]);
    expect(skipped[0]?.error).toContain("skipped");
  });

  it("returns nothing when the last case failed", () => {
    expect(skipRemaining(cases, 3)).toEqual([]);
  });

  it("keeps the total honest — scored plus failed equals the set", () => {
    // The point of recording skips rather than dropping them: a scorecard
    // reporting 1 failure out of 6 cases when 5 never ran would be a lie.
    expect(skipRemaining(cases, 1).length + 1).toBe(cases.length);
  });
});
