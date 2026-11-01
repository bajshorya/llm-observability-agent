import { describe, expect, it } from "vitest";
import {
  describeBudget,
  isFreeProvider,
  remainingRequests,
  requestsForCall,
  utcDayStart,
} from "./budget";

describe("budget", () => {
  it("counts what is left, never below zero", () => {
    expect(remainingRequests({ cap: 15, usedToday: 4 })).toBe(11);
    expect(remainingRequests({ cap: 15, usedToday: 17 })).toBe(0);
  });

  it("is unlimited when there is no cap", () => {
    expect(remainingRequests({ cap: null, usedToday: 500 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("charges repairs as requests", () => {
    expect(requestsForCall(0)).toBe(1);
    expect(requestsForCall(2)).toBe(3);
  });

  it("resets on the UTC day, not the local one", () => {
    expect(utcDayStart(new Date("2026-11-01T23:59:59.999Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-11-02T00:00:00.000Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("does not budget providers that cost nothing", () => {
    expect(isFreeProvider("stub")).toBe(true);
    expect(isFreeProvider("ollama")).toBe(true);
    expect(isFreeProvider("gemini")).toBe(false);
  });

  it("describes itself", () => {
    expect(describeBudget({ cap: 15, usedToday: 3 })).toBe("3/15 requests today");
    expect(describeBudget({ cap: null, usedToday: 0 })).toBe("unbudgeted (local provider)");
  });
});
