/**
 * Synthetic traffic for a fake orders service — the healthy baseline and all
 * seven injectable scenarios.
 *
 * WHAT THIS FILE DOES
 * Everything about what the generated traffic looks like. `generateMinute()` is
 * the single entry point: given a traffic profile, a window start, a random
 * source and optionally a scenario, it returns the log entries for that window.
 * `index.ts` handles the CLI and HTTP; this file decides what the data *is*.
 *
 * WHY IT EXISTS BEFORE THE DETECTORS DID
 * Built first, on purpose. It gave us realistic data to develop against from
 * day one, it drives the demo, and it is where the golden eval cases come from.
 *
 * WHY THE BASELINE IS NOT A FLAT LINE
 * Healthy traffic has to be *believable*. A constant request rate with a uniform
 * error rate would let a naive detector look far better than it is. So the
 * baseline carries a gentle diurnal curve, per-minute jitter, four weighted
 * endpoints with different latency profiles, and three kinds of error that occur
 * in normal operation — timeouts, 404s and 429s. Those baseline errors are what
 * the new-signature detector must NOT flag as novel.
 *
 * THE SEVEN SCENARIOS, AND THE SPLIT THAT MATTERS
 * Four are real incidents; three are benign windows that trip Tier 1 anyway.
 *
 *   error-spike        incident  40× error rate from known failure kinds
 *   latency-jump       incident  p95 ×8 across every endpoint, no new errors
 *   new-error          incident  a novel TypeError returning 500s
 *   limiter-misconfig  incident  a rate limiter rejecting legitimate traffic
 *   deploy-restart     BENIGN    a burst that recovers inside the window
 *   batch-job          BENIGN    a background path is slow; users are fine
 *   rate-limit-storm   BENIGN    one client throttled; nothing else degrades
 *
 * `limiter-misconfig` was added for Phase 3 rather than Phase 2, and it is the
 * only scenario whose primary job is CORRELATION. Its cause is a different
 * commit from `new-error`'s, which is what stops the correlation eval from
 * being satisfiable by a model that has learned to answer "the pricing one".
 * It is also the sharpest pair with `rate-limit-storm`: the same mechanism,
 * the same status code, opposite verdicts.
 *
 * The benign three exist to test the only thing Tier 2 can do that statistics
 * cannot. `deploy-restart` is the sharpest: it fires the SAME TWO DETECTORS at
 * comparable magnitudes as `new-error`, so no threshold can separate them. The
 * only difference is that its logs say "v1.4.2 starting up" and the errors stop
 * after a minute.
 *
 * TWO CAPABILITIES THE SCENARIO INTERFACE HAS, AND WHY
 *   `progress`   position within the injection, 0..1, so a scenario can have
 *                phases. "Already recovering" is the strongest benign signal
 *                there is and a constant profile cannot express it.
 *   `context()`  extra entries: narration ("Rollout complete"), and requests
 *                the scenario itself makes. The second half was added after a
 *                measured failure — the first `batch-job` multiplied EVERY
 *                request's latency and called itself benign, which made it an
 *                incident wearing a benign label. A scenario has to contain its
 *                impact, not narrate it away.
 */

import { randomUUID } from "node:crypto";
import type { LogEntryInput } from "@obs/shared";
import type { Rng } from "./random";

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
  "limiter-misconfig",
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

/**
 * A scenario-specific entry: either narration, or work the scenario itself is
 * doing.
 *
 * The request fields exist because a benign window cannot be created by
 * narrating a bad one. A background job that saturates the pool has to show up
 * as *its own* slow requests on *its own* path — if instead you multiply every
 * request's latency and attach a friendly log line, you have built an incident
 * and labelled it benign, which is what the first version of these scenarios
 * did.
 */
export interface ContextLine {
  message: string;
  level: "info" | "warn";
  offsetMs?: number;
  /** Present when this line represents a real request rather than narration. */
  endpoint?: string;
  statusCode?: number;
  latencyMs?: number;
}

/** Fraction of the injection window a deploy's restart burst occupies. */
const RESTART_PHASE = 0.2;

/**
 * Batch-job volume per generated window, against a baseline of ~240 requests a
 * minute. Enough that the job's own slow requests own the top of the
 * distribution — which is what moves p95 while leaving p50 alone.
 */
const BATCH_OPS_PER_WINDOW = 45;
const BATCH_SKIPS_PER_WINDOW = 12;

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
      "A never-before-seen error signature appears — the null-price bug from commit 0c701a0",
    benign: false,
    profile: (base) => ({ ...base, errorRate: 0.3 }),
    error: {
      // Matches the bug committed to the target repository built by
      // scripts/build-fixture-repo.sh, so correlation has something true to
      // find. The sha is named in the description above but deliberately NOT
      // in any emitted log line — a packet that contains the answer tests
      // nothing but the model's ability to copy a string.
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
   * A background job dragging the aggregate while users are fine.
   *
   * The service-wide p95 explodes and the latency detector fires — correctly.
   * But p50 barely moves, because the slow requests are all the job's own, on
   * its own path. That bimodal shape is the actual signature of a background
   * workload polluting a shared metric, and it is very common in real systems.
   *
   * The earlier version of this scenario multiplied *every* request's latency
   * by eight and called itself benign on the strength of a log line. That was
   * a mislabelled incident: at a p95 of 1.4 seconds every user was suffering,
   * whatever the cause. Contain the impact, don't narrate it away.
   */
  "batch-job": {
    description:
      "Nightly reconciliation drags the aggregate p95 while user traffic stays healthy",
    benign: true,
    // User traffic is deliberately untouched — the job's own work is emitted below.
    profile: (base) => base,
    context: (_windowStart, rng, progress) => {
      const lines: ContextLine[] = [
        progress < 0.15
          ? {
              level: "info",
              message: `Nightly reconciliation batch ${rng.int(4000, 4999)} started: 50000 orders queued`,
            }
          : {
              level: "info",
              message: "Reconciliation in progress, connection pool at 18 of 20",
            },
      ];

      // The job's own chunks: slow, and the only thing moving the service p95.
      for (let i = 0; i < BATCH_OPS_PER_WINDOW; i += 1) {
        lines.push({
          level: "info",
          message: `Reconciled chunk ${rng.int(1, 500)} of batch`,
          endpoint: "/internal/reconcile",
          statusCode: 200,
          latencyMs: rng.latency(3200, 2.5),
          offsetMs: rng.int(0, 59_000),
        });
      }

      // Its skip warnings — 409s, so they never reach the error-rate detector,
      // but they are a novel signature and the new-signature detector fires.
      for (let i = 0; i < BATCH_SKIPS_PER_WINDOW; i += 1) {
        lines.push({
          level: "warn",
          message: `Record ${rng.int(80_000, 89_999)} already processed, skipping`,
          endpoint: "/internal/reconcile",
          statusCode: 409,
          latencyMs: rng.latency(140, 2),
          offsetMs: rng.int(0, 59_000),
        });
      }

      return lines;
    },
  },

  /**
   * One abusive client, throttled correctly.
   *
   * The subtlest case in the set, and after the fix the quietest: a rate
   * limiter rejects immediately, so nothing slows down and no error level is
   * involved — 429s are warnings. The only thing that fires is the
   * new-signature detector, on the quota warning itself.
   *
   * That makes it a clean test of one question: a brand-new warning appeared,
   * and it describes a protection working exactly as designed. Is that an
   * incident? The first version answered this by slowing every request down
   * six-fold, which made "other clients unaffected" a claim the data flatly
   * contradicted.
   */
  /**
   * The rate limiter turned on legitimate traffic.
   *
   * The exact inverse of `rate-limit-storm`, and deliberately so. There, one
   * abusive client is throttled and the protection is working; here the
   * protection is misconfigured and is rejecting ordinary write traffic from
   * hundreds of clients. Same mechanism, same 429, opposite verdicts — and
   * nothing in the numbers separates them, because the normalised signature of
   * a 429 is identical either way.
   *
   * WHAT SEPARATES THEM IS ONE NARRATION LINE, in both scenarios. That is not
   * a shortcut: an operator distinguishes these two situations by reading the
   * quota warning too. The benign one names a single client and says
   * "throttling that client only"; this one reports a rejection rate across
   * hundreds of distinct clients.
   *
   * WHY IT EXISTS: CORRELATION, NOT CLASSIFICATION
   * This is the second scenario whose cause is a real commit in the fixture
   * repository, and it is a DIFFERENT commit from `new-error`'s. With only one
   * attributable incident, a correlation eval cannot tell a model that reasons
   * from one that has learned the answer is always the pricing commit.
   *
   * The link is checkable rather than given away: the warning reports the
   * effective burst and refill the limiter is running with, and one candidate
   * commit is the one that introduced a token bucket with those numbers. No
   * sha appears anywhere in the log text.
   *
   * WHY 429s STILL TRIP TIER 1
   * They do not, on their own — 429 is a warning, so the error-rate detector
   * never sees it, and the normalised signature matches the baseline's. What
   * fires is the new-signature detector, on the quota warning itself. Exactly
   * the same route `rate-limit-storm` takes, which is what makes the pair fair.
   */
  "limiter-misconfig": {
    description:
      "A rate limiter set too tight rejects legitimate writes from hundreds of clients",
    benign: false,
    profile: (base) => ({
      ...base,
      // Rejecting is cheap, so latency is untouched — the damage is that the
      // requests never happen, not that they are slow. The error rate here is
      // the share of traffic the limiter is turning away.
      errorRate: 0.38,
    }),
    error: {
      // A wide spread of client ids, unlike rate-limit-storm's single one. The
      // normalised signature is the baseline's, so this reads as volume rather
      // than novelty — same as the benign case, on purpose.
      message: (rng) => `Rate limit exceeded for client ${rng.int(1_000, 9_999)}`,
      errorType: "RateLimitError",
      statusCode: 429,
    },
    context: (_windowStart, rng, progress) => [
      {
        level: "warn",
        message:
          `Rate limiter rejecting ${rng.int(34, 41)}% of write requests across ` +
          `${rng.int(1_400, 1_900)} distinct clients in the last minute ` +
          `(burst 120, refill 2/s)`,
      },
      // Still happening at the end of the window. "Already recovering" is the
      // strongest benign signal there is, and this scenario must not offer it.
      ...(progress > 0.5
        ? [
            {
              level: "warn" as const,
              message:
                "Checkout write failures sustained: /orders and /orders/:id/refund " +
                "rejecting at quota for 4 consecutive minutes",
              offsetMs: 30_000,
            },
          ]
        : []),
    ],
  },

  "rate-limit-storm": {
    description:
      "A single client floods the API and is throttled: 429s, and nothing else degrades",
    benign: true,
    profile: (base) => ({
      ...base,
      // The flood is real volume. Latency is untouched, because rejecting a
      // request is cheap — that is the whole point of a rate limiter.
      requestsPerMinute: base.requestsPerMinute * 4,
      errorRate: 0.45,
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
   * Scenario-specific entries.
   *
   * Pure narration carries no endpoint or status — it describes the service,
   * not a request. Entries that *do* carry them represent work the scenario is
   * performing, and are aggregated by the rollup exactly like any other
   * request, which is how a background job shows up in the service p95 without
   * touching what users experience.
   */
  for (const line of scenario?.context?.(windowStart, rng, progress) ?? []) {
    // Live mode ticks are shorter than a minute; keep offsets inside the window.
    const offsetMs = Math.min(line.offsetMs ?? 0, windowMs - 1);

    entries.push({
      timestamp: new Date(windowStart.getTime() + offsetMs),
      service: effective.service,
      level: line.level,
      message: line.message,
      metadata: {
        ...(line.endpoint === undefined ? {} : { endpoint: line.endpoint }),
        ...(line.statusCode === undefined ? {} : { statusCode: line.statusCode }),
        ...(line.latencyMs === undefined ? {} : { latencyMs: line.latencyMs }),
      },
    });
  }

  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
