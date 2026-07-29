import { describe, expect, it } from "vitest";
import { mean, median, percentile, stdDev } from "./stats";

describe("mean", () => {
  it("returns 0 for an empty set rather than NaN", () => {
    // NaN would propagate silently through every threshold comparison.
    expect(mean([])).toBe(0);
  });

  it("averages values", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe("stdDev", () => {
  it("returns 0 when there is not enough data to have a spread", () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([42])).toBe(0);
  });

  it("returns 0 for a constant series", () => {
    expect(stdDev([3, 3, 3, 3])).toBe(0);
  });

  it("uses the sample formula (n-1), not the population formula", () => {
    // [1,2,3,4,5]: sum of squared deviations = 10.
    // Sample: sqrt(10/4) = 1.5811.  Population would be sqrt(10/5) = 1.4142.
    expect(stdDev([1, 2, 3, 4, 5])).toBeCloseTo(1.5811, 4);
  });
});

describe("percentile", () => {
  it("returns 0 for an empty set", () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it("returns the only value for a single-element set", () => {
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("sorts input before computing", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
  });

  it("interpolates between neighbouring ranks", () => {
    // rank = (5-1) * 0.95 = 3.8 -> between index 3 (=4) and 4 (=5)
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 5);
  });

  it("clamps p outside [0,1] instead of reading past the array", () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores extreme outliers, which is why the latency baseline uses it", () => {
    const withSpikes = [60, 60, 60, 60, 60, 5000, 5000];
    expect(median(withSpikes)).toBe(60);
    // The mean is dragged an order of magnitude upward by the same data.
    expect(mean(withSpikes)).toBeGreaterThan(1000);
  });
});
