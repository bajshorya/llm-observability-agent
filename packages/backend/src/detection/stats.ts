/**
 * Small statistics helpers, kept pure and separate so they can be tested
 * directly rather than only through the detectors that use them.
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
