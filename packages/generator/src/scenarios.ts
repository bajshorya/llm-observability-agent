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

export const SCENARIO_NAMES = [
  "error-spike",
  "latency-jump",
  "new-error",
  "deploy-restart",
  "batch-job",
  "rate-limit-storm",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface Scenario {
  readonly description: string;
  /**
   * True when a correct classifier should dismiss this window as benign.
   *
   * Every one of these still trips Tier 1 — that is the point. Statistics
   * cannot separate a deploy restart from an outage, so the benign scenarios
   * exist to test the only thing that can: reading the log text.
   */
  readonly benign: boolean;
  /**
   * `progress` is the position within the injection window, 0 at its start and
   * approaching 1 at its end. It exists so a scenario can have phases — an
   * incident that recovers looks nothing like one that does not, and "already
   * recovering" is one of the strongest benign signals there is.
   */
  readonly profile: (base: TrafficProfile, progress: number) => TrafficProfile;
  /** Overrides the error pool when present — used to introduce a novel signature. */
  readonly error?: FailureKind;
  /**
   * Lines that say what is happening, emitted once per generated window.
   *
   * This is the load-bearing part of every benign scenario. A burst of
   * connection-refused errors is an outage; the same burst next to "v1.4.2
   * starting up" is a deploy. Without these lines the benign cases would be
   * genuinely indistinguishable from incidents, and an eval built on them
   * would be measuring an impossible task rather than a hard one.
   */
  readonly context?: (
    windowStart: Date,
    rng: Rng,
    progress: number,
  ) => readonly ContextLine[];
}

/** A scenario-specific narration line. Always benign-level; never an error. */
export interface ContextLine {
  message: string;
  level: "info" | "warn";
  offsetMs?: number;
}

/** Fraction of the injection window a deploy's restart burst occupies. */
const RESTART_PHASE = 0.2;

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "error-spike": {
    description: "Error rate jumps ~40x using errors already seen in the baseline",
    benign: false,
    profile: (base) => ({ ...base, errorRate: 0.35 }),
  },
  "latency-jump": {
    description: "Tail latency degrades sharply with no change in error rate",
    benign: false,
    profile: (base) => ({
      ...base,
      latencyMedianMs: base.latencyMedianMs * 8,
      latencyTailFactor: base.latencyTailFactor * 1.6,
    }),
  },
  "new-error": {
    description:
      "A never-before-seen error signature appears — the null-price bug from commit a3f9c21",
    benign: false,
    profile: (base) => ({ ...base, errorRate: 0.3 }),
    error: {
      // Matches the bug we inject into the target app, so correlation has
      // something true to find.
      message: () => "TypeError: Cannot read properties of null (reading 'toFixed')",
      errorType: "TypeError",
      statusCode: 500,
    },
  },

  /**
   * The canonical false positive. A rollout drops connections while the new
   * instances come up, then recovers completely. Statistically this is an
   * error-rate spike with a novel signature — indistinguishable from the
   * null-price bug above. The difference is entirely in the words.
   */
  "deploy-restart": {
    description:
      "Instances restart during a rollout: a short connection-refused burst, then full recovery",
    benign: true,
    profile: (base, progress) =>
      progress < RESTART_PHASE
        ? { ...base, errorRate: 0.45, latencyMedianMs: base.latencyMedianMs * 2 }
        : base,
    error: {
      message: () => "Connection refused: upstream orders-db not ready",
      errorType: "ConnectionRefusedError",
      statusCode: 503,
    },
    context: (_windowStart, _rng, progress) =>
      progress < RESTART_PHASE
        ? [
            { level: "info", message: "orders-api v1.4.2 starting up (deploy 7c1e044)" },
            {
              level: "warn",
              message: "Draining connections for rolling restart, 1 of 3 instances cycling",
              offsetMs: 2_000,
            },
          ]
        : [
            {
              level: "info",
              message: "Rollout complete: 3 of 3 instances healthy, health checks passing",
            },
          ],
  },

  /**
   * Latency degradation with no user-facing failure. The warnings it emits are
   * a novel signature, so the new-signature detector fires — correctly, and
   * still benignly. This is the case that shows a trigger firing is not the
   * same as something being wrong.
   */
  "batch-job": {
    description:
      "Nightly reconciliation saturates the pool: latency climbs, no user-facing errors",
    benign: true,
    profile: (base) => ({
      ...base,
      latencyMedianMs: base.latencyMedianMs * 8,
      latencyTailFactor: base.latencyTailFactor * 1.5,
      // Only the batch's own skip warnings, which are 409s rather than errors.
      errorRate: 0.06,
    }),
    error: {
      message: (rng) => `Record ${rng.int(80_000, 89_999)} already processed, skipping`,
      errorType: "DuplicateRecordError",
      statusCode: 409,
    },
    context: (_windowStart, rng, progress) =>
      progress < 0.15
        ? [
            {
              level: "info",
              message: `Nightly reconciliation batch ${rng.int(4000, 4999)} started: 50000 orders queued`,
            },
          ]
        : [
            {
              level: "info",
              message: "Reconciliation in progress, connection pool at 18 of 20",
            },
          ],
  },

  /**
   * One abusive client, throttled correctly. 429s are warnings rather than
   * errors, so the error-rate detector stays quiet; the queueing shows up as a
   * latency jump. A protection mechanism working as designed is the subtlest
   * benign case here, because something genuinely is being refused.
   */
  "rate-limit-storm": {
    description:
      "A single client floods the API: 429s and queueing latency, other clients unaffected",
    benign: true,
    profile: (base) => ({
      ...base,
      requestsPerMinute: base.requestsPerMinute * 4,
      latencyMedianMs: base.latencyMedianMs * 6,
      errorRate: 0.4,
    }),
    error: {
      // One client id, unlike the baseline's random spread. The normalised
      // signature is identical to the baseline's, so this does NOT read as a
      // new signature — only as volume.
      message: () => "Rate limit exceeded for client 4471",
      errorType: "RateLimitError",
      statusCode: 429,
    },
    context: () => [
      {
        level: "warn",
        message:
          "Client 4471 exceeded quota: 12000 requests in 60s, throttling that client only",
      },
    ],
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
 *
 * `progress` is the position of this window within the injection, 0..1. Only
 * phased scenarios read it; everything else behaves identically at any value,
 * which is why it defaults to 1 (steady state) for backfill and live traffic.
 */
export function generateMinute(
  profile: TrafficProfile,
  windowStart: Date,
  rng: Rng,
  scenario?: Scenario,
  windowMs: number = MINUTE_MS,
  progress = 1,
): GeneratedEntry[] {
  const effective = scenario ? scenario.profile(profile, progress) : profile;
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

  /**
   * Narration last, so it is never displaced by the request loop's sampling.
   * These carry no endpoint or status: they describe the service, not a
   * request, and the rollup counts them as the handful of extra entries they
   * are.
   */
  for (const line of scenario?.context?.(windowStart, rng, progress) ?? []) {
    entries.push({
      timestamp: new Date(windowStart.getTime() + (line.offsetMs ?? 0)),
      service: effective.service,
      level: line.level,
      message: line.message,
      metadata: {},
    });
  }

  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
