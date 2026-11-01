import { describe, expect, it } from "vitest";
import { chartRange, layout, minuteGrid, niceMax, tickIndices } from "./chart";

const t = (hhmm: string) => new Date(`2026-11-01T${hhmm}:00.000Z`);
const frame = { width: 100, height: 50, left: 0, right: 0, top: 0, bottom: 0 };

describe("minuteGrid", () => {
  const rows = [
    { bucketStart: t("12:00"), requestCount: 10, errorCount: 1, p95Ms: 80 },
    { bucketStart: t("12:02"), requestCount: 12, errorCount: 4, p95Ms: 300 },
  ];

  it("makes missing minutes explicit: zero errors, NO latency", () => {
    const grid = minuteGrid(rows, t("12:00"), t("12:03"));
    expect(grid.map((p) => p.errors)).toEqual([1, 0, 4]);
    // A silent minute has no p95 — drawing zero would invent a cliff.
    expect(grid.map((p) => p.p95)).toEqual([80, null, 300]);
  });
});

describe("layout", () => {
  const grid = minuteGrid(
    [
      { bucketStart: t("12:00"), requestCount: 10, errorCount: 2, p95Ms: 80 },
      { bucketStart: t("12:02"), requestCount: 10, errorCount: 5, p95Ms: 100 },
      { bucketStart: t("12:03"), requestCount: 10, errorCount: 0, p95Ms: 90 },
    ],
    t("12:00"),
    t("12:04"),
  );

  it("draws one bar per minute with errors, scaled to a nice max", () => {
    const g = layout(grid, "errors", frame, null);
    expect(g.yMax).toBe(5);
    expect(g.bars).toHaveLength(2);
    expect(g.bars[1]?.height).toBe(50);
  });

  it("breaks the latency line across a minute with no traffic", () => {
    const g = layout(grid, "p95", frame, null);
    expect(g.line.match(/M/g)).toHaveLength(2);
  });

  it("clips the window band to the plot", () => {
    const g = layout(grid, "errors", frame, { start: t("11:00"), end: t("12:02") });
    expect(g.band).toEqual({ x: 0, width: 50 });
  });

  it("draws no band for a window entirely outside the range", () => {
    expect(layout(grid, "errors", frame, { start: t("13:00"), end: t("13:05") }).band).toBeNull();
  });
});

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 × 10^n", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(72)).toBe(100);
    expect(niceMax(170)).toBe(200);
    expect(niceMax(200)).toBe(200);
  });
});

describe("tickIndices", () => {
  it("always includes both ends", () => {
    expect(tickIndices(100, 5)).toEqual([0, 25, 50, 74, 99]);
    expect(tickIndices(3, 7)).toEqual([0, 1, 2]);
  });
});

describe("chartRange", () => {
  it("adds context either side", () => {
    const r = chartRange(t("12:00"), t("12:05"), { beforeMinutes: 60, afterMinutes: 10, maxMinutes: 240 });
    expect(r.from).toEqual(t("11:00"));
    expect(r.to).toEqual(t("12:15"));
  });

  it("keeps the END of a long window in view", () => {
    const r = chartRange(t("06:00"), t("12:00"), { beforeMinutes: 60, afterMinutes: 0, maxMinutes: 120 });
    expect(r.from).toEqual(t("10:00"));
    expect(r.to).toEqual(t("12:00"));
  });
});
