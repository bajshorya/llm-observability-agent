/**
 * Tests for the pinned Tier 2 verdicts.
 *
 * These read the committed fixtures rather than literals, because the
 * invariant worth protecting is about the fixtures themselves: a correlation
 * case whose scenario has no pinned verdict cannot be re-captured, and a
 * malformed verdict fails capture at the point where the least context is
 * available to explain it.
 *
 * That is the same reasoning that makes `cases.ts` validate on load — a
 * benchmark whose fixtures are wrong reports a model problem.
 */

import { describe, expect, it } from "vitest";
import { loadCorrelationCases } from "./correlation-cases";
import { listPinnedVerdicts, loadPinnedVerdict } from "./verdicts";

describe("pinned verdicts", () => {
  it("has at least one", () => {
    expect(listPinnedVerdicts().length).toBeGreaterThan(0);
  });

  it("parses every committed verdict", () => {
    for (const scenario of listPinnedVerdicts()) {
      const verdict = loadPinnedVerdict(scenario);
      expect(verdict.scenario).toBe(scenario);
      expect(verdict.summary.length).toBeGreaterThan(10);
      expect(verdict.note.length).toBeGreaterThan(0);
    }
  });

  it("covers every scenario the correlation set uses", () => {
    // Without this, a case can exist that `capture-correlation-cases.sh`
    // cannot rebuild — and the failure would surface only during a re-capture,
    // which is exactly when the set is least able to absorb a surprise.
    const pinned = new Set(listPinnedVerdicts());

    for (const golden of loadCorrelationCases()) {
      expect(pinned.has(golden.scenario), `no pinned verdict for "${golden.scenario}"`).toBe(true);
    }
  });

  it("names the missing scenarios when one is absent", () => {
    // A silent fallback to a live classification would reintroduce the very
    // variance the pin removes, and would do it invisibly.
    expect(() => loadPinnedVerdict("no-such-scenario")).toThrow(/No pinned verdict/);
  });

  it("stores a verdict that matches what the case's packet contains", () => {
    // The pin is only meaningful if capture actually used it. If these drift,
    // the stored cases came from somewhere else.
    for (const golden of loadCorrelationCases()) {
      const verdict = loadPinnedVerdict(golden.scenario);

      expect(golden.context).toContain(`Severity: ${verdict.severity}`);
      expect(golden.context).toContain(`Affected area: ${verdict.affectedArea}`);
      expect(golden.context).toContain(verdict.summary);
    }
  });
});
