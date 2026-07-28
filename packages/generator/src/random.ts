/**
 * Seeded PRNG (mulberry32).
 *
 * Deterministic generation matters more than it looks: it means a failing
 * detector test can be reproduced exactly, and that the demo produces the
 * same story every time you run it.
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
