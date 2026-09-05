/**
 * Tests for correlation case loading.
 *
 * Covers the two arms staying apart, and the distinction between "no case by
 * that name" and "the set is empty" — which the CLI reported as the same thing
 * until an end-to-end sweep caught it. Telling someone to capture cases they
 * already have is a small bug that costs real time.
 */

import { describe, expect, it } from "vitest";
import { loadCorrelationCases } from "./correlation-cases";

describe("loadCorrelationCases", () => {
  it("returns the default arm, excluding the with-hunks cases", () => {
    const cases = loadCorrelationCases();

    expect(cases.length).toBeGreaterThan(0);
    for (const golden of cases) expect(golden.name.startsWith("diff-")).toBe(false);
  });

  it("returns the diff arm when asked, and only that", () => {
    const cases = loadCorrelationCases(undefined, "diff");

    expect(cases.length).toBeGreaterThan(0);
    for (const golden of cases) expect(golden.name.startsWith("diff-")).toBe(true);
  });

  it("never blends the two arms", () => {
    // A score averaged across two packet formats describes neither.
    const a = new Set(loadCorrelationCases().map((c) => c.name));
    const b = new Set(loadCorrelationCases(undefined, "diff").map((c) => c.name));

    for (const name of a) expect(b.has(name)).toBe(false);
  });

  it("returns a named case from either arm without an arm flag", () => {
    const [plain] = loadCorrelationCases("new-error");
    const [withDiff] = loadCorrelationCases("diff-new-error");

    expect(plain?.name).toBe("new-error");
    expect(withDiff?.name).toBe("diff-new-error");
  });

  it("returns nothing for a name that does not exist", () => {
    // The CLI relies on this to say "no case named X" rather than "the set is
    // empty" — two different problems with two different next steps.
    expect(loadCorrelationCases("no-such-case")).toEqual([]);
  });
});
