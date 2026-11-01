import { describe, expect, it } from "vitest";
import { backedOffIds, isNewFailure, MAX_BACKOFF_TICKS, recordFailure } from "./backoff";

describe("backoff", () => {
  it("doubles the wait with each consecutive failure", () => {
    let entry = recordFailure(undefined, 10, "boom");
    expect(entry).toEqual({ failures: 1, retryAtTick: 11, lastError: "boom" });
    entry = recordFailure(entry, 11, "boom");
    expect(entry.retryAtTick).toBe(13);
    entry = recordFailure(entry, 13, "boom");
    expect(entry.retryAtTick).toBe(17);
  });

  it("caps the wait", () => {
    let entry = recordFailure(undefined, 0, "boom");
    for (let i = 0; i < 20; i += 1) entry = recordFailure(entry, 1000, "boom");
    expect(entry.retryAtTick).toBe(1000 + MAX_BACKOFF_TICKS);
  });

  it("passes over an anomaly only while it is backing off", () => {
    const entries = new Map([["a", recordFailure(undefined, 5, "boom")]]);
    expect(backedOffIds(entries, 5)).toEqual(["a"]);
    expect(backedOffIds(entries, 6)).toEqual([]);
  });

  it("reports a failure once, and again only when it changes", () => {
    const entry = recordFailure(undefined, 0, "quota");
    expect(isNewFailure(undefined, "quota")).toBe(true);
    expect(isNewFailure(entry, "quota")).toBe(false);
    expect(isNewFailure(entry, "repo missing")).toBe(true);
  });
});
