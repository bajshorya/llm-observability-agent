import { describe, expect, it } from "vitest";
import { MINUTE_MS, planLateRuns, resumeRowid } from "./rollup-plan";

const m = (n: number) => n * MINUTE_MS;

describe("planLateRuns", () => {
  it("coalesces consecutive minutes into one run per service", () => {
    const minutes = [3, 1, 2, 2, 7].map((n) => ({ service: "a", minute: m(n) }));
    expect(planLateRuns(minutes, m(100))).toEqual([
      { service: "a", start: m(1), end: m(4) },
      { service: "a", start: m(7), end: m(8) },
    ]);
  });

  it("keeps services apart", () => {
    const runs = planLateRuns(
      [
        { service: "b", minute: m(1) },
        { service: "a", minute: m(1) },
        { service: "a", minute: m(2) },
      ],
      m(100),
    );
    expect(runs).toEqual([
      { service: "a", start: m(1), end: m(3) },
      { service: "b", start: m(1), end: m(2) },
    ]);
  });

  it("drops minutes the time-based tail already covers, so none is counted twice", () => {
    const minutes = [8, 9, 10, 11].map((n) => ({ service: "a", minute: m(n) }));
    expect(planLateRuns(minutes, m(10))).toEqual([{ service: "a", start: m(8), end: m(10) }]);
  });

  it("returns nothing for nothing", () => {
    expect(planLateRuns([], m(10))).toEqual([]);
  });
});

describe("resumeRowid", () => {
  it("starts from zero with no state", () => {
    expect(resumeRowid(null, 500)).toBe(0);
  });

  it("resumes from the stored watermark", () => {
    expect(resumeRowid(120, 500)).toBe(120);
  });

  it("restarts when rowids were reused below the watermark", () => {
    expect(resumeRowid(900, 40)).toBe(0);
  });
});
