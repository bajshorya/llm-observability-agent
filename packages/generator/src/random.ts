/**
 * Seeded pseudo-random number generation for the traffic generator.
 *
 * WHAT THIS FILE DOES
 * Exports `createRng(seed)`, returning a small deterministic random source with
 * the handful of primitives the generator needs: `next` (uniform 0..1), `int`,
 * `pick` from an array, `bool` at a given probability, and `latency`.
 *
 * WHY SEEDED RATHER THAN Math.random
 * Determinism matters more here than it looks. It means a failing detector test
 * can be reproduced exactly from its seed, and that the demo tells the same
 * story every time it is run — which is the difference between a demo you can
 * rehearse and one that surprises you in front of an audience.
 *
 * THE ALGORITHM
 * mulberry32: a 32-bit state, a handful of shifts and multiplies, and a period
 * long enough for anything this project does. Chosen because it is nine lines
 * and needs no dependency — the quality bar here is "looks like plausible
 * traffic", not cryptographic randomness.
 *
 * WHY LATENCY IS NOT UNIFORM
 * `latency(medianMs, tailFactor)` draws from a LOG-NORMAL distribution via
 * Box–Muller: a normal sample, exponentiated. Real request latency is not
 * symmetric — it clusters just above a floor with a long right tail, and
 * occasional very slow requests are normal rather than exceptional.
 *
 * This shape is what makes p95 and p99 meaningful metrics to compute, and what
 * makes the latency detector worth writing. Uniform random latency would give
 * p50 ≈ p95 and the detector would have nothing to detect.
 */
export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability: number): boolean;
  /** Log-normal-ish positive value — the shape real latency actually has. */
  latency(medianMs: number, tailFactor: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (minInclusive, maxInclusive) =>
      minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("pick() called on an empty array");
      return item;
    },
    bool: (probability) => next() < probability,
    latency: (medianMs, tailFactor) => {
      // Box–Muller for a normal sample, exponentiated into a log-normal.
      const u1 = Math.max(next(), Number.EPSILON);
      const u2 = next();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const sigma = Math.log(tailFactor) / 2;
      return Math.max(1, Math.round(medianMs * Math.exp(normal * sigma)));
    },
  };

  return rng;
}
