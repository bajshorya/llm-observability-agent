import { describe, expect, it } from "vitest";
import { detectionConfig } from "./config";
import {
  detectErrorRateSpike,
  detectLatencyJump,
  detectNewErrorSignature,
  runDetectors,
  type BaselineStats,
  type WindowStats,
} from "./detectors";

/**
 * Tests run against the **real** config rather than a fixture, so a change to
 * a threshold that breaks an assumption fails here rather than silently
 * altering the system's sensitivity in production.
 */
const config = detectionConfig;

function makeWindow(overrides: Partial<WindowStats> = {}): WindowStats {
  const base: WindowStats = {
    service: "orders-api",
    minutes: 5,
    requestCount: 1200,
    errorCount: 5,
    p95Ms: 60,
    p99Ms: 90,
    signatures: new Map(),
  };
  return { ...base, ...overrides };
}

/** 60 minutes cycling 1..6: mean 3.5, sample stddev ~1.72, threshold ~8.66. */
const NOISY_ERROR_BASELINE = Array.from({ length: 60 }, (_, i) => (i % 6) + 1);

function makeBaseline(overrides: Partial<BaselineStats> = {}): BaselineStats {
  const base: BaselineStats = {
    errorCountsPerMinute: NOISY_ERROR_BASELINE,
    p95PerMinute: Array.from({ length: 60 }, () => 60),
    signatures: new Set(["Order <num> not found"]),
    minutes: 60,
  };
  return { ...base, ...overrides };
}

describe("detectErrorRateSpike", () => {
  it("fires when errors per minute exceed mean + k*stddev", () => {
    // 50 errors / 5 min = 10/min, against a threshold of ~8.66.
    const trigger = detectErrorRateSpike(
      makeWindow({ errorCount: 50 }),
      makeBaseline(),
      config,
    );

    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("error_rate_spike");
    if (trigger?.kind === "error_rate_spike") {
      expect(trigger.observedErrors).toBe(50);
      expect(trigger.baselineMean).toBeCloseTo(3.5, 1);
      expect(trigger.zScore).toBeGreaterThan(config.errorRate.stdDevMultiplier);
    }
  });

  it("stays quiet when the rate sits inside normal variation", () => {
    // 15 errors / 5 min = 3/min — above the absolute floor, below the threshold,
    // so this exercises the statistical test rather than the floor.
    expect(detectErrorRateSpike(makeWindow({ errorCount: 15 }), makeBaseline(), config)).toBeNull();
  });

  it("respects the absolute floor even when the baseline is perfectly flat", () => {
    // A silent service: any error at all is infinitely many standard deviations
    // from a zero-variance baseline. The floor is what stops that firing.
    const trigger = detectErrorRateSpike(
      makeWindow({ errorCount: 5 }), // 1/min, below minErrorsPerMinute (2)
      makeBaseline({ errorCountsPerMinute: Array.from({ length: 60 }, () => 0) }),
      config,
    );
    expect(trigger).toBeNull();
  });

  it("clamps the z-score to a finite value on a zero-variance baseline", () => {
    // JSON.stringify(Infinity) is null, which would corrupt the stored trigger.
    const trigger = detectErrorRateSpike(
      makeWindow({ errorCount: 50 }),
      makeBaseline({ errorCountsPerMinute: Array.from({ length: 60 }, () => 0) }),
      config,
    );

    expect(trigger).not.toBeNull();
    if (trigger?.kind === "error_rate_spike") {
      expect(Number.isFinite(trigger.zScore)).toBe(true);
      expect(JSON.parse(JSON.stringify(trigger)).zScore).toBe(trigger.zScore);
    }
  });
});

describe("detectLatencyJump", () => {
  it("fires when p95 is a large multiple of the baseline", () => {
    const trigger = detectLatencyJump(makeWindow({ p95Ms: 500 }), makeBaseline(), config);

    expect(trigger).not.toBeNull();
    if (trigger?.kind === "latency_jump") {
      expect(trigger.metric).toBe("p95");
      expect(trigger.observedMs).toBe(500);
      expect(trigger.baselineMs).toBe(60);
      expect(trigger.ratio).toBeCloseTo(8.33, 1);
    }
  });

  it("ignores a dramatic ratio on trivially small latencies", () => {
    // 20ms -> 190ms is nearly a 10x jump and completely meaningless to a user.
    const trigger = detectLatencyJump(
      makeWindow({ p95Ms: 190 }),
      makeBaseline({ p95PerMinute: Array.from({ length: 60 }, () => 20) }),
      config,
    );
    expect(trigger).toBeNull();
  });

  it("stays quiet when the ratio is below threshold", () => {
    const trigger = detectLatencyJump(
      makeWindow({ p95Ms: 250 }),
      makeBaseline({ p95PerMinute: Array.from({ length: 60 }, () => 100) }),
      config,
    );
    expect(trigger).toBeNull();
  });

  it("is not suppressed by latency spikes already present in the baseline", () => {
    // 55 normal minutes plus 5 spikes. The mean would be ~470ms and would hide
    // a real 300ms regression; the median stays at 60ms and catches it.
    const spiky = [
      ...Array.from({ length: 55 }, () => 60),
      ...Array.from({ length: 5 }, () => 5000),
    ];
    const trigger = detectLatencyJump(
      makeWindow({ p95Ms: 300 }),
      makeBaseline({ p95PerMinute: spiky }),
      config,
    );

    expect(trigger).not.toBeNull();
    if (trigger?.kind === "latency_jump") {
      expect(trigger.baselineMs).toBe(60);
    }
  });

  it("stays quiet when there is no latency baseline at all", () => {
    const trigger = detectLatencyJump(
      makeWindow({ p95Ms: 5000 }),
      makeBaseline({ p95PerMinute: [] }),
      config,
    );
    expect(trigger).toBeNull();
  });
});

describe("detectNewErrorSignature", () => {
  const novel = "TypeError: Cannot read properties of null (reading <str>)";

  it("fires for a signature absent from the baseline", () => {
    const trigger = detectNewErrorSignature(
      makeWindow({
        signatures: new Map([
          [novel, { occurrences: 12, sampleMessage: "TypeError: ... (reading 'toFixed')" }],
        ]),
      }),
      makeBaseline(),
      config,
    );

    expect(trigger).not.toBeNull();
    if (trigger?.kind === "new_error_signature") {
      expect(trigger.signature).toBe(novel);
      expect(trigger.occurrences).toBe(12);
      expect(trigger.sampleMessage).toContain("toFixed");
    }
  });

  it("ignores signatures already seen in the baseline, however frequent", () => {
    const trigger = detectNewErrorSignature(
      makeWindow({
        signatures: new Map([
          ["Order <num> not found", { occurrences: 900, sampleMessage: "Order 1 not found" }],
        ]),
      }),
      makeBaseline(),
      config,
    );
    expect(trigger).toBeNull();
  });

  it("ignores a novel signature that has not recurred enough to be credible", () => {
    const trigger = detectNewErrorSignature(
      makeWindow({
        signatures: new Map([[novel, { occurrences: 2, sampleMessage: "x" }]]),
      }),
      makeBaseline(),
      config,
    );
    expect(trigger).toBeNull();
    expect(config.newSignature.minOccurrences).toBeGreaterThan(2);
  });

  it("reports the most frequent novel signature when several appear at once", () => {
    const trigger = detectNewErrorSignature(
      makeWindow({
        signatures: new Map([
          ["rare novel signature", { occurrences: 4, sampleMessage: "rare" }],
          ["dominant novel signature", { occurrences: 300, sampleMessage: "dominant" }],
        ]),
      }),
      makeBaseline(),
      config,
    );

    if (trigger?.kind === "new_error_signature") {
      expect(trigger.signature).toBe("dominant novel signature");
    } else {
      expect.unreachable("expected a new_error_signature trigger");
    }
  });
});

describe("runDetectors", () => {
  it("returns nothing for a healthy window", () => {
    expect(runDetectors(makeWindow(), makeBaseline(), config)).toEqual([]);
  });

  it("returns every trigger that fired, since one incident can set off several", () => {
    const triggers = runDetectors(
      makeWindow({
        errorCount: 50,
        p95Ms: 500,
        signatures: new Map([["novel", { occurrences: 40, sampleMessage: "boom" }]]),
      }),
      makeBaseline(),
      config,
    );

    expect(triggers.map((t) => t.kind).sort()).toEqual([
      "error_rate_spike",
      "latency_jump",
      "new_error_signature",
    ]);
  });
});
