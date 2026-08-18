/**
 * Tier 1 detection thresholds — every number that decides what counts as an
 * anomaly.
 *
 * WHAT THIS FILE DOES
 * Exports one frozen config object. Nothing else in the detection pipeline
 * contains a magic number; the detectors, the engine and the CLI all read from
 * here.
 *
 * WHY THEY ARE ALL IN ONE PLACE
 * The sensitivity of the whole system is the sum of these ten values. Scattered
 * through the detectors they would be impossible to reason about together, and
 * impossible to justify in review. Every value below carries the reasoning for
 * its default, because "why is k = 3?" is the first question anyone asks.
 *
 * THE SHAPE OF A DETECTION RUN, IN THESE TERMS
 *
 *     |<--------- baselineMinutes (60) --------->|  gap  |<- window (5) ->|
 *     |............ what "normal" means .........|  (1)  |  under test    |
 *                                                          ^
 *                                            fires → create or extend anomaly
 *
 * THE PATTERN EVERY DETECTOR FOLLOWS: RATIO **AND** FLOOR
 * Each detector pairs a relative threshold with an absolute minimum:
 *
 *   errorRate    mean + 3σ   AND at least 2 errors/min
 *   latency      3× baseline AND at least 200 ms observed
 *   signature    unseen      AND at least 3 occurrences
 *
 * The ratio is what makes detection adaptive to each service's normal. The
 * floor is a correction for statistics genuinely misbehaving at small numbers:
 * on a quiet service the baseline standard deviation approaches zero, which
 * makes a single extra error a >3σ event, and a latency move from 2 ms to 8 ms
 * is a 4× regression no user could perceive. The floors are not fudge factors —
 * they are where the statistical model stops applying.
 *
 * TUNING
 * Raise `stdDevMultiplier` or the floors for fewer false positives; lower them
 * to catch more. Run `pnpm test` afterwards — several tests assert against this
 * real object rather than a fixture, so a change that contradicts a documented
 * assumption fails loudly instead of silently altering sensitivity.
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
