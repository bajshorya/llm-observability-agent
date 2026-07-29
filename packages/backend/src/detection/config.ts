/**
 * Tier 1 detection thresholds.
 *
 * Every tunable lives here rather than scattered through the detectors, so the
 * sensitivity of the system can be reasoned about — and later justified — in
 * one place. Each value carries the reasoning for its default, because
 * "why is k = 3?" is the first question anyone reviewing this will ask.
 */
export const detectionConfig = {
  /**
   * How much history a window is compared against. One hour is long enough to
   * absorb normal minute-to-minute variance, short enough that a genuine
   * regression does not get absorbed into its own baseline.
   */
  baselineMinutes: 60,

  /**
   * Detection is skipped entirely until this much baseline exists. On a service
   * with no history every signature is novel and every number is unusual, so
   * running detectors early would produce a burst of meaningless anomalies the
   * moment the system starts.
   */
  minBaselineMinutes: 30,

  /**
   * Size of the window under evaluation. Five minutes smooths out single-minute
   * noise while still catching an incident quickly.
   */
  windowMinutes: 5,

  /**
   * Gap between the window and the baseline. Without this the window's own
   * data would leak into the baseline it is being compared against, and a
   * slow-building incident would quietly raise its own bar.
   */
  baselineGapMinutes: 1,

  errorRate: {
    /**
     * k in `mean + k·stddev`. Three standard deviations is ~99.7% of a normal
     * distribution — deliberately conservative, because Tier 1's job is to be
     * cheap and quiet, not to catch everything.
     */
    stdDevMultiplier: 3,
    /**
     * Absolute floor. On a very quiet service the baseline stddev approaches
     * zero, which would make a single extra error a >3σ event. Requiring a
     * meaningful absolute count stops that.
     */
    minErrorsPerMinute: 2,
  },

  latency: {
    /** Observed p95 must be at least this multiple of the baseline p95. */
    ratioThreshold: 3,
    /**
     * Absolute floor. A jump from 2ms to 8ms is a 4x ratio and completely
     * meaningless to a user; below this, latency changes are not worth waking
     * anyone for.
     */
    minObservedMs: 200,
  },

  newSignature: {
    /**
     * A signature must appear this many times in the window before it counts
     * as novel. One occurrence is as likely to be a fluke as a regression.
     */
    minOccurrences: 3,
  },

  /**
   * A sustained incident produces a firing window on every run. Rather than
   * creating a new anomaly each time, an existing open anomaly whose window
   * ended within this many minutes is extended instead.
   */
  anomalyMergeGapMinutes: 10,
} as const;

export type DetectionConfig = typeof detectionConfig;
