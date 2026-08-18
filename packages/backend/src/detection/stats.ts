/**
 * The statistics primitives — four functions, each chosen deliberately.
 *
 * WHAT THIS FILE DOES
 * Provides `mean`, `stdDev`, `percentile` and `median` to the detectors and the
 * rollup worker. Pure functions over arrays of numbers: no database, no clock,
 * no I/O. Kept separate so they can be tested directly rather than only through
 * the detectors that use them.
 *
 * THE THREE CHOICES THAT ARE NOT OBVIOUS
 *
 * 1. `stdDev` uses BESSEL'S CORRECTION (dividing by n−1, not n).
 *    The baseline is a *sample* of the service's behaviour, not the complete
 *    population of every minute it will ever run. The population formula
 *    understates spread, which would make the error-rate detector fire more
 *    readily than its 3σ threshold claims.
 *
 * 2. `percentile` INTERPOLATES rather than picking the nearest rank.
 *    With 20 values, nearest-rank p95 can only ever land on one of two
 *    observations, which makes the metric jump between two values from minute
 *    to minute. Interpolation makes per-minute p95 a smooth series, which is
 *    what the latency detector compares against.
 *
 * 3. `median` exists specifically for the LATENCY baseline, while the error
 *    baseline uses `mean`. This asymmetry is intentional. A latency spike
 *    already sitting inside the baseline window would drag a mean upward and
 *    raise the detection bar — making the detector least sensitive exactly
 *    when a service has recently been misbehaving. The median ignores those
 *    outliers. The error baseline keeps the mean because `stdDev` is defined
 *    around it and the pair is what produces a z-score.
 *
 * Every function returns 0 for an empty input rather than NaN, so a service
 * with no baseline data produces a quiet "nothing to compare" rather than
 * poisoning arithmetic downstream.
 */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Sample standard deviation (Bessel's correction, n-1).
 *
 * The baseline is a *sample* of the service's behaviour, not the complete
 * population of all minutes it will ever run. Using the population formula
 * would understate the spread and make the detector fire too readily.
 */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Linear-interpolated percentile. `p` is a fraction in [0, 1].
 *
 * Interpolating rather than picking the nearest rank matters at small sample
 * sizes: with 20 values, nearest-rank p95 can only ever land on one of two
 * observations, which makes the metric jumpy from minute to minute.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;

  const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;

  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

/**
 * Median — used for the latency baseline specifically.
 *
 * The mean would be dragged upwards by any latency spike already present in
 * the baseline window, raising the bar exactly when a service has recently
 * misbehaved. The median ignores those outliers.
 */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}
