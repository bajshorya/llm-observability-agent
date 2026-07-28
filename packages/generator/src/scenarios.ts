import { randomUUID } from "node:crypto";
import type { LogEntryInput } from "@obs/shared";
import type { Rng } from "./random";

/**
 * Synthetic traffic for a fake orders service.
 *
 * This exists before the detectors do, on purpose: it gives us realistic data
 * to develop against from day one, and later doubles as the demo driver.
 * Healthy traffic has to be *believable* — a flat line with a uniform error
 * rate would let a naive detector look far better than it is.
 */

export interface TrafficProfile {
  service: string;
  requestsPerMinute: number;
  /** Fraction of requests that fail, 0..1. */
  errorRate: number;
  latencyMedianMs: number;
  /** Spread of the latency tail; 1 is flat, higher is heavier. */
  latencyTailFactor: number;
}

export const BASELINE: TrafficProfile = {
  service: "orders-api",
  requestsPerMinute: 240,
  errorRate: 0.008,
  latencyMedianMs: 45,
  latencyTailFactor: 3,
};

interface Endpoint {
  method: string;
  path: string;
  /** Relative traffic share. */
  weight: number;
  latencyMultiplier: number;
}

const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/orders", weight: 5, latencyMultiplier: 1 },
  { method: "GET", path: "/orders/:id", weight: 8, latencyMultiplier: 0.8 },
  { method: "POST", path: "/orders", weight: 3, latencyMultiplier: 2.2 },
  { method: "POST", path: "/orders/:id/refund", weight: 1, latencyMultiplier: 3 },
];

export interface FailureKind {
  /**
   * Built per-occurrence rather than fixed, so the same failure produces
   * many distinct raw messages. This is what actually exercises signature
   * normalisation — a fixture with hardcoded ids would let a broken
   * normaliser pass, because there would be nothing to collapse.
   */
  message: (rng: Rng) => string;
  errorType: string;
  statusCode: number;
}

/** Failures that exist in normal operation — the detector must NOT flag these as novel. */
const BASELINE_ERRORS: readonly FailureKind[] = [
  {
    message: (rng) =>
      `Upstream timeout contacting payments-service after ${rng.pick([2500, 3000, 5000])}ms`,
    errorType: "UpstreamTimeoutError",
    statusCode: 504,
  },
  {
    message: (rng) => `Order ${rng.int(10_000, 99_999)} not found`,
    errorType: "NotFoundError",
    statusCode: 404,
  },
  {
    message: (rng) => `Rate limit exceeded for client ${rng.int(1_000, 9_999)}`,
    errorType: "RateLimitError",
    statusCode: 429,
  },
];

export const SCENARIO_NAMES = ["error-spike", "latency-jump", "new-error"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface Scenario {
  readonly description: string;
  readonly profile: (base: TrafficProfile) => TrafficProfile;
  /** Overrides the error pool when present — used to introduce a novel signature. */
  readonly error?: FailureKind;
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "error-spike": {
    description: "Error rate jumps ~40x using errors already seen in the baseline",
    profile: (base) => ({ ...base, errorRate: 0.35 }),
  },
  "latency-jump": {
    description: "Tail latency degrades sharply with no change in error rate",
    profile: (base) => ({
      ...base,
      latencyMedianMs: base.latencyMedianMs * 8,
      latencyTailFactor: base.latencyTailFactor * 1.6,
    }),
  },
  "new-error": {
    description:
      "A never-before-seen error signature appears — the null-price bug from commit a3f9c21",
    profile: (base) => ({ ...base, errorRate: 0.3 }),
    error: {
      // Matches the bug we inject into the target app, so correlation has
      // something true to find.
      message: () => "TypeError: Cannot read properties of null (reading 'toFixed')",
      errorType: "TypeError",
      statusCode: 500,
    },
  },
};

function pickEndpoint(rng: Rng): Endpoint {
  const totalWeight = ENDPOINTS.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng.next() * totalWeight;
  for (const endpoint of ENDPOINTS) {
    roll -= endpoint.weight;
    if (roll <= 0) return endpoint;
  }
  return ENDPOINTS[0] as Endpoint;
}

/**
 * Traffic is not constant through the day. A gentle diurnal curve keeps the
 * baseline from being trivially predictable, which is what makes the
 * mean+stddev detector worth writing rather than a flat threshold.
 */
function diurnalMultiplier(at: Date): number {
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return 0.75 + 0.35 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
}

/**
 * `LogEntryInput.timestamp` is intentionally permissive (Zod coerces strings,
 * numbers, or Dates). Internally we always produce a real Date so we can sort.
 */
export type GeneratedEntry = LogEntryInput & { timestamp: Date };

const MINUTE_MS = 60_000;

/**
 * Generate traffic for the window starting at `windowStart`.
 * Defaults to one minute; live mode uses shorter ticks.
 */
export function generateMinute(
  profile: TrafficProfile,
  windowStart: Date,
  rng: Rng,
  scenario?: Scenario,
  windowMs: number = MINUTE_MS,
): GeneratedEntry[] {
  const effective = scenario ? scenario.profile(profile) : profile;
  const jitter = 0.85 + rng.next() * 0.3;
  const requestCount = Math.max(
    1,
    Math.round(
      effective.requestsPerMinute *
        (windowMs / MINUTE_MS) *
        diurnalMultiplier(windowStart) *
        jitter,
    ),
  );

  const entries: GeneratedEntry[] = [];

  for (let i = 0; i < requestCount; i += 1) {
    const endpoint = pickEndpoint(rng);
    const offsetMs = Math.floor(rng.next() * windowMs);
    const timestamp = new Date(windowStart.getTime() + offsetMs);
    const latencyMs = rng.latency(
      effective.latencyMedianMs * endpoint.latencyMultiplier,
      effective.latencyTailFactor,
    );
    const requestId = randomUUID();
    const failed = rng.bool(effective.errorRate);

    if (!failed) {
      const statusCode = endpoint.method === "POST" ? 201 : 200;
      entries.push({
        timestamp,
        service: effective.service,
        level: "info",
        message: `${endpoint.method} ${endpoint.path} ${statusCode}`,
        metadata: {
          requestId,
          endpoint: endpoint.path,
          method: endpoint.method,
          statusCode,
          latencyMs,
        },
      });
      continue;
    }

    const failure = scenario?.error ?? rng.pick(BASELINE_ERRORS);
    entries.push({
      timestamp,
      service: effective.service,
      level: failure.statusCode >= 500 ? "error" : "warn",
      message: failure.message(rng),
      metadata: {
        requestId,
        endpoint: endpoint.path,
        method: endpoint.method,
        statusCode: failure.statusCode,
        latencyMs,
        errorType: failure.errorType,
      },
    });
  }

  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
