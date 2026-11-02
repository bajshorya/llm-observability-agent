import { describe, expect, it } from "vitest";
import { DAY_MS, retentionCutoffs } from "./retention-policy";

const now = new Date("2026-11-02T12:00:00.000Z");

describe("retentionCutoffs", () => {
  it("cuts each table at its own age", () => {
    const cutoffs = retentionCutoffs(now, { logDays: 14, rollupDays: 90 });
    expect(cutoffs.logsBefore?.getTime()).toBe(now.getTime() - 14 * DAY_MS);
    expect(cutoffs.rollupsBefore?.getTime()).toBe(now.getTime() - 90 * DAY_MS);
  });

  it("treats 0 as keep forever", () => {
    expect(retentionCutoffs(now, { logDays: 0, rollupDays: 0 })).toEqual({ logsBefore: null, rollupsBefore: null });
  });

  it("refuses a retention that would delete detection's baseline", () => {
    expect(() => retentionCutoffs(now, { logDays: 0.01, rollupDays: 90 })).toThrow(/baseline/);
  });

  it("refuses nonsense", () => {
    expect(() => retentionCutoffs(now, { logDays: -1, rollupDays: 90 })).toThrow();
    expect(() => retentionCutoffs(now, { logDays: Number.NaN, rollupDays: 90 })).toThrow();
  });
});
