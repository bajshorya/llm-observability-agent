/**
 * The silence detector — pure, so the clock is just another argument.
 *
 * What these pin down is the three gates and their order: out of scope when
 * last heard from long ago, not silence when the gap is short, and not
 * abnormal when the service is normally quiet. Each is a way the detector
 * would otherwise cry wolf.
 */

import { describe, expect, it } from "vitest";
import { detectionConfig } from "./config";
import { detectSilence } from "./detectors";

const MINUTE = 60_000;
const now = new Date("2026-11-01T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * MINUTE);

const busy = (lastSeenMinutesAgo: number, rate = 40) => ({
  service: "orders-api",
  lastSeenAt: minutesAgo(lastSeenMinutesAgo),
  baselineLinesPerMinute: rate,
});

describe("detectSilence", () => {
  it("fires when a busy service has been quiet for a whole window", () => {
    const trigger = detectSilence(busy(12), now, detectionConfig);
    expect(trigger).toEqual({
      kind: "service_silent",
      service: "orders-api",
      lastSeenAt: "2026-11-01T11:48:00.000Z",
      silentMinutes: 12,
      baselineLinesPerMinute: 40,
    });
  });

  it("does not fire on a gap shorter than the window", () => {
    expect(detectSilence(busy(detectionConfig.silence.minSilentMinutes - 1), now, detectionConfig)).toBeNull();
  });

  it("fires exactly at the threshold", () => {
    expect(detectSilence(busy(detectionConfig.silence.minSilentMinutes), now, detectionConfig)).not.toBeNull();
  });

  it("does not fire for a service whose normal is quiet", () => {
    const rate = detectionConfig.silence.minBaselineLinesPerMinute - 0.5;
    expect(detectSilence(busy(30, rate), now, detectionConfig)).toBeNull();
  });

  it("ignores services last heard from beyond the lookback", () => {
    // An old database or a retired service must not alarm on the first run.
    const past = detectionConfig.silence.maxLookbackMinutes + 1;
    expect(detectSilence(busy(past), now, detectionConfig)).toBeNull();
  });

  it("never fires on a pinned-time capture, whose data is months old", () => {
    const capture = {
      service: "orders-api",
      lastSeenAt: new Date("2026-08-16T19:02:00Z"),
      baselineLinesPerMinute: 400,
    };
    expect(detectSilence(capture, now, detectionConfig)).toBeNull();
  });

  it("does not fire when the newest line is in the future of `now`", () => {
    // Clock skew between a sender and this host must not read as silence.
    expect(detectSilence(busy(-2), now, detectionConfig)).toBeNull();
  });
});
