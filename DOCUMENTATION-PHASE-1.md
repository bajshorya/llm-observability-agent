# Technical Documentation — Phase 1: Tier 1 Detection

Complete reference for the detection pipeline: every file, every function, what
the code does, how it works, and why it was written that way.

**Scope:** Phase 1. Six source files plus two test files, all under
`packages/backend/src/detection/`. Statistics only — no LLM, no API key, no cost.

Phase 0 (foundations, ingestion, generator) is documented separately in
[`DOCUMENTATION.md`](./DOCUMENTATION.md).

- [1. What Phase 1 delivers](#1-what-phase-1-delivers)
- [2. Where it sits in the pipeline](#2-where-it-sits-in-the-pipeline)
- [3. Architecture: the pure / impure split](#3-architecture-the-pure--impure-split)
- [4. `config.ts` — every threshold](#4-configts--every-threshold)
- [5. `stats.ts` — the statistics primitives](#5-statsts--the-statistics-primitives)
- [6. `detectors.ts` — the three detectors](#6-detectorsts--the-three-detectors)
- [7. `rollup.ts` — raw logs to aggregates](#7-rollupts--raw-logs-to-aggregates)
- [8. `engine.ts` — loading, orchestration, persistence](#8-enginets--loading-orchestration-persistence)
- [9. `cli.ts` — the operator interface](#9-clits--the-operator-interface)
- [10. The tests](#10-the-tests)
- [11. End-to-end walkthrough of one run](#11-end-to-end-walkthrough-of-one-run)
- [12. Worked example with real numbers](#12-worked-example-with-real-numbers)
- [13. The statistics, explained](#13-the-statistics-explained)
- [14. Design decisions and trade-offs](#14-design-decisions-and-trade-offs)
- [15. Verification results](#15-verification-results)
- [16. Known limitations](#16-known-limitations)
- [17. Running and tuning](#17-running-and-tuning)

---

## 1. What Phase 1 delivers

A **working anomaly detector with zero LLM involvement.**

That sentence is the entire point. The project's central claim is that a two-tier
funnel — cheap statistics first, LLM only on what survives — is better
engineering than sending everything to a model. That claim is only honest if
Tier 1 genuinely works on its own. If the statistics were weak and the model were
quietly doing all the real work, the architecture would be a rationalisation
rather than a design.

So Phase 1 has to stand up unassisted, and be measurable:

| Requirement | Delivered |
|---|---|
| Detects error-rate spikes | `mean + 3σ` against a trailing baseline, with an absolute floor |
| Detects latency regressions | window p95 vs a **median** baseline, ratio threshold plus floor |
| Detects novel failures | signatures absent from the baseline, minimum occurrence count |
| Produces no false positives on healthy traffic | Verified: 0 anomalies on a clean 120-minute baseline |
| Is provable, not just testable | 27 unit tests over pure functions with fixed inputs |
| Costs nothing to run | No network calls of any kind |

**What it deliberately does *not* do:** decide whether an anomaly is a *real
incident*. A deploy restart and an outage look statistically identical; telling
them apart requires reading the log text, which is exactly the judgement Tier 2
exists to make. The `severity`, `summary` and `is_real_incident` columns are
written as `null` and left for Phase 2.

---

## 2. Where it sits in the pipeline

```
                    Phase 0                          Phase 1
        ┌──────────────────────────┐   ┌──────────────────────────────────┐

  app ──▶ POST /ingest ──▶ logs table ──▶ rollup.ts ──▶ metrics_rollup
                                  │                            │
                                  │                            ▼
                                  │                     ┌─────────────┐
                                  └────signatures──────▶│  engine.ts  │
                                                        └──────┬──────┘
                                                               │ WindowStats
                                                               │ BaselineStats
                                                               ▼
                                                        ┌──────────────┐
                                                        │ detectors.ts │  ← pure
                                                        └──────┬───────┘
                                                               │ AnomalyTrigger[]
                                                               ▼
                                                          anomalies table
                                                               │
                                                               ▼
                                                         Phase 2 (LLM)
```

Two inputs feed the detectors, and they come from different places for a reason:

- **Counts and latency** come from `metrics_rollup` — pre-aggregated, sixty rows
  per hour instead of tens of thousands.
- **Error signatures** come from the `logs` table directly, because a signature is
  a string that cannot be summed into a per-minute rollup. This read is narrow: it
  filters on `error_signature IS NOT NULL`, which excludes ~99% of rows.

---

## 3. Architecture: the pure / impure split

The single most important structural decision in this phase.

| File | Lines | Touches DB / clock? | Role |
|---|---:|---|---|
| `config.ts` | 80 | No | Every threshold, in one place |
| `stats.ts` | 57 | No | mean, sample stddev, percentile, median |
| `detectors.ts` | 176 | No | The three detectors |
| `rollup.ts` | 180 | **Yes** | Raw logs → per-minute aggregates |
| `engine.ts` | 317 | **Yes** | Load, detect, persist |
| `cli.ts` | 144 | **Yes** | `pnpm detect` |
| `stats.test.ts` | 68 | No | Unit tests |
| `detectors.test.ts` | 246 | No | Unit tests |
| **Total** | **1,268** | | |

### Why it is split this way

`detectors.ts` takes plain numbers and returns plain objects. It has no database
connection, no `Date.now()`, no file access, no network. That gives three things:

**1. The logic can be proven, not spot-checked.** A test supplies an exact
baseline and an exact window and asserts an exact trigger. There is no fixture
database to seed, no clock to freeze, no async to await. All 27 tests run in 6ms.

**2. Bugs cannot hide behind I/O.** If a detector misbehaves, it is a pure
function of its inputs — reproducible from the inputs alone. Compare with the
alternative, where a detector queries the database itself: then "it did not fire"
could mean the maths is wrong, or the query is wrong, or the data is not there,
and you cannot tell which without instrumentation.

**3. The thresholds become a first-class artifact.** Because `config.ts` is
injected rather than imported inside the detectors, a test can pass a different
config, and a future dashboard could show current sensitivity without reading
source code.

The cost of the split is one extra layer: `engine.ts` has to translate database
rows into `WindowStats` and `BaselineStats`. That translation is boring code —
which is the point. All the boring code is in one place and all the interesting
code is testable.

---

## 4. `config.ts` — every threshold

Sensitivity is the first thing anyone reviewing this system will question, so
every tunable lives in one file with its reasoning attached rather than scattered
through the detectors as magic numbers.

```ts
export const detectionConfig = { /* ... */ } as const;
export type DetectionConfig = typeof detectionConfig;
```

`as const` makes the object deeply readonly, so no code path can mutate the
thresholds at runtime. `DetectionConfig` is derived from the value rather than
declared separately, so the type can never drift from the defaults.

### Window and baseline

| Setting | Value | Reasoning |
|---|---:|---|
| `baselineMinutes` | 60 | Long enough to absorb normal minute-to-minute variance; short enough that a genuine regression does not get absorbed into its own baseline. |
| `windowMinutes` | 5 | Smooths single-minute noise while still catching an incident quickly. |
| `baselineGapMinutes` | 1 | Separates the window from the baseline. |
| `minBaselineMinutes` | 30 | Detection is skipped entirely below this. |

**The gap is the subtle one.** Without it, the window under evaluation would be
part of the baseline it is compared against. A slow-building incident would then
quietly raise its own bar — every minute of degradation would nudge the baseline
mean upward, and the ramp could continue indefinitely without ever crossing the
threshold. One minute of separation is enough to break that feedback loop.

**`minBaselineMinutes` prevents a startup flood.** On a service with no history,
every signature is novel and every number is unusual. Running detectors
immediately would produce a burst of meaningless anomalies the moment the system
comes up — the worst possible first impression for an alerting tool. Below the
threshold, `engine.ts` reports *why* it skipped rather than silently returning
nothing.

### Error rate

| Setting | Value | Reasoning |
|---|---:|---|
| `errorRate.stdDevMultiplier` | 3 | k in `mean + k·σ`. Three standard deviations is ~99.7% of a normal distribution — deliberately conservative, because Tier 1's job is to be cheap and quiet, not to catch everything. |
| `errorRate.minErrorsPerMinute` | 2 | Absolute floor. |

The floor exists because of a specific failure mode: **on a very quiet service
the baseline standard deviation approaches zero**, which makes a single extra
error an infinitely-many-sigma event. Without a floor, detection would be loudest
on precisely the services behaving best. See §6.1 and §13.3.

### Latency

| Setting | Value | Reasoning |
|---|---:|---|
| `latency.ratioThreshold` | 3 | Observed p95 must be at least 3x baseline. |
| `latency.minObservedMs` | 200 | Absolute floor. |

A jump from 2ms to 8ms is a 4x ratio and completely imperceptible to a user.
Below 200ms, latency changes are not worth waking anyone for regardless of how
dramatic the multiplier looks.

### New signature

| Setting | Value | Reasoning |
|---|---:|---|
| `newSignature.minOccurrences` | 3 | One occurrence is as likely to be a fluke as a regression. |

### Deduplication

| Setting | Value | Reasoning |
|---|---:|---|
| `anomalyMergeGapMinutes` | 10 | An open anomaly whose window ended this recently is extended rather than duplicated. |

A sustained incident fires on every run. Without this, a ten-minute outage would
produce a wall of near-identical anomaly rows — and from Phase 2 onward, a
duplicated LLM call for each one. **This setting is a cost control as much as a
UX one.**

---

## 5. `stats.ts` — the statistics primitives

Four pure functions. Small enough to read in a minute, load-bearing enough that
each carries a real decision.

### `mean(values)`

```ts
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
```

The empty guard matters more than it looks. Without it, `[].reduce(...) / 0`
yields `NaN`, and **every subsequent comparison against `NaN` is `false`** — so a
detector would silently never fire rather than loudly failing. Returning 0 makes
an empty baseline behave as "no history", which the callers already handle.

### `stdDev(values)` — sample, not population

```ts
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
```

Note the `n - 1` (Bessel's correction). The baseline is a **sample** of how the
service behaves, not the complete population of every minute it will ever run.
Using the population formula (`n`) would understate the spread, which lowers the
`mean + 3σ` threshold and makes the detector fire more readily than intended.

With 60 baseline minutes the difference is small (`√(60/59)` ≈ 0.8%), but it is
correct, and on short baselines it matters more.

The `< 2` guard exists because variance is undefined for a single sample —
`n - 1` would be zero and the result `Infinity`.

### `percentile(values, p)` — interpolated

```ts
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
```

Three details:

- **`[...values]` copies before sorting.** `Array.prototype.sort` mutates in
  place; sorting the caller's array would corrupt data the caller still needs.
- **`Math.min(Math.max(p, 0), 1)` clamps `p`.** An out-of-range `p` would compute
  an index past the end of the array and, under `noUncheckedIndexedAccess`,
  produce `undefined` — which the `as number` casts would hide.
- **Interpolation, not nearest rank.** With 20 samples, nearest-rank p95 can only
  ever land on one of two observations, which makes the metric jump around from
  minute to minute for no real reason. Interpolating gives a smoother signal, and
  a smoother signal means a smaller standard deviation, which means fewer false
  positives.

### `median(values)`

```ts
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}
```

Used specifically for the **latency baseline**, and the choice is deliberate. See
§13.2.

---

## 6. `detectors.ts` — the three detectors

### The input types

```ts
export interface WindowStats {
  service: string;
  minutes: number;            // used to normalise counts
  requestCount: number;
  errorCount: number;
  p95Ms: number;
  p99Ms: number;
  signatures: ReadonlyMap<string, SignatureOccurrence>;
}

export interface BaselineStats {
  errorCountsPerMinute: readonly number[];   // one entry per minute
  p95PerMinute: readonly number[];
  signatures: ReadonlySet<string>;
  minutes: number;
}
```

`BaselineStats` keeps **per-minute arrays** rather than pre-computed aggregates.
That is what allows the detectors to compute spread themselves — you cannot
recover a standard deviation from a mean. It also means a future detector can ask
a different question of the same baseline without changing how it is loaded.

Both use `readonly` / `Readonly*` types so a detector cannot accidentally mutate
the statistics it was handed.

### The z-score clamp

```ts
const MAX_Z_SCORE = 999;

function safeZScore(observed: number, baselineMean: number, baselineStdDev: number): number {
  if (baselineStdDev <= 0) {
    return observed > baselineMean ? MAX_Z_SCORE : 0;
  }
  return Number(((observed - baselineMean) / baselineStdDev).toFixed(2));
}
```

A zero-variance baseline (a service with exactly the same error count every
minute — very common when that count is zero) produces a division by zero and an
infinite z-score.

**This would corrupt stored data silently.** `JSON.stringify(Infinity)` is
`"null"`, and the trigger is persisted as JSON in the `anomalies.triggers`
column. The value would round-trip as `null`, fail Zod validation on read, and
the failure would surface far from its cause. Clamping to a large finite value
keeps the meaning ("far outside normal") and the serialisability.

There is a test asserting the trigger survives `JSON.parse(JSON.stringify(...))`
unchanged.

`toFixed(2)` keeps stored numbers readable — a z-score of `26.63` rather than
`26.633333333333333`.

### 6.1 `detectErrorRateSpike`

```ts
export function detectErrorRateSpike(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  const observedPerMinute = window.errorCount / Math.max(window.minutes, 1);

  // Absolute floor first — cheapest check, rejects the noisiest case.
  if (observedPerMinute < config.errorRate.minErrorsPerMinute) return null;

  const baselineMean = mean(baseline.errorCountsPerMinute);
  const baselineStdDev = stdDev(baseline.errorCountsPerMinute);
  const threshold = baselineMean + config.errorRate.stdDevMultiplier * baselineStdDev;

  if (observedPerMinute <= threshold) return null;

  return {
    kind: "error_rate_spike",
    service: window.service,
    observedErrors: window.errorCount,
    baselineMean: Number(baselineMean.toFixed(2)),
    baselineStdDev: Number(baselineStdDev.toFixed(2)),
    zScore: safeZScore(observedPerMinute, baselineMean, baselineStdDev),
  };
}
```

**Normalisation to per-minute** is what makes the window size configurable. The
window has 5 minutes of errors; the baseline has 60 individual per-minute counts.
Comparing a 5-minute total against a 1-minute distribution would be an
apples-to-oranges error of exactly 5x. `Math.max(window.minutes, 1)` guards
against a division by zero when a window has no rollup buckets at all.

**Floor checked first**, before computing mean and standard deviation. Cheapest
check first, and it rejects the highest-volume noise case without touching the
baseline arrays.

**The trigger carries its own evidence** — observed count, baseline mean, baseline
spread, and the z-score. The dashboard can therefore show *why* the detector
fired, not merely that it did. That is the reasoning trace beginning at the very
first step of the pipeline, before any LLM is involved.

### 6.2 `detectLatencyJump`

```ts
export function detectLatencyJump(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  if (window.p95Ms < config.latency.minObservedMs) return null;

  const baselineP95 = median(baseline.p95PerMinute);
  if (baselineP95 <= 0) return null;          // nothing to compare against

  const ratio = window.p95Ms / baselineP95;
  if (ratio < config.latency.ratioThreshold) return null;

  return {
    kind: "latency_jump",
    service: window.service,
    metric: "p95",
    observedMs: Math.round(window.p95Ms),
    baselineMs: Math.round(baselineP95),
    ratio: Number(ratio.toFixed(2)),
  };
}
```

**`median`, not `mean`, for the baseline.** If a latency spike is already sitting
in the baseline window, the mean is dragged upward — making the detector *least*
sensitive exactly when a service has recently been misbehaving. There is a test
for this with concrete numbers: 55 minutes at 60ms plus 5 minutes at 5000ms gives
a mean of ~470ms (which would hide a real 300ms regression) and a median of 60ms
(which catches it as a 5x jump).

**`baselineP95 <= 0` guard.** A service with no recorded latencies has a zero
baseline; dividing by it yields `Infinity`, which would fire on every window
forever. Returning `null` treats "no baseline" as "cannot judge" rather than
"everything is an anomaly".

**p95 rather than p99.** p99 is noisier at the sample sizes involved — with ~150
requests per minute, p99 is determined by roughly one request. p95 is stable
enough to have a meaningful baseline while still being a tail metric. `p99Ms` is
carried on `WindowStats` for future use and for display.

### 6.3 `detectNewErrorSignature`

```ts
export function detectNewErrorSignature(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger | null {
  let best: { signature: string; occurrence: SignatureOccurrence } | null = null;

  for (const [signature, occurrence] of window.signatures) {
    if (baseline.signatures.has(signature)) continue;
    if (occurrence.occurrences < config.newSignature.minOccurrences) continue;
    if (!best || occurrence.occurrences > best.occurrence.occurrences) {
      best = { signature, occurrence };
    }
  }

  if (!best) return null;

  return {
    kind: "new_error_signature",
    service: window.service,
    signature: best.signature,
    sampleMessage: best.occurrence.sampleMessage,
    occurrences: best.occurrence.occurrences,
  };
}
```

**This is the only detector that can catch a brand-new failure on its first
occurrence**, before it has had time to become a statistical spike. The other two
need a *quantity* of bad behaviour; this one needs only novelty.

It is also **entirely dependent on the signature normalisation from Phase 0.**
Without it, ordinary id variation would make almost every error message look
novel and the detector would fire constantly on healthy traffic. The measured
collapse — 87 distinct raw messages into one signature — is what makes this
detector viable at all.

`Set.has()` is O(1), so the loop is linear in the number of distinct signatures in
the window (typically single digits), not in the number of log rows.

**Both the signature and a sample raw message are reported.** The signature is
what the detector reasoned about; the sample is what a human needs in order to
recognise the failure. `TypeError: Cannot read properties of null (reading
<str>)` is precise but abstract; `...(reading 'toFixed')` is what makes it click.
The sample also becomes useful context for the Phase 2 classifier.

### 6.4 `runDetectors`

```ts
export function runDetectors(
  window: WindowStats,
  baseline: BaselineStats,
  config: DetectionConfig,
): AnomalyTrigger[] {
  return [
    detectErrorRateSpike(window, baseline, config),
    detectLatencyJump(window, baseline, config),
    detectNewErrorSignature(window, baseline, config),
  ].filter((trigger): trigger is AnomalyTrigger => trigger !== null);
}
```

Returns **all** triggers that fired, not the first. A single incident commonly
sets off several — the verification run's `new-error` case fires two — and each
carries independent evidence worth keeping for the correlation agent later.

The type predicate `(t): t is AnomalyTrigger => t !== null` is what narrows
`(AnomalyTrigger | null)[]` to `AnomalyTrigger[]`; a plain `Boolean` filter would
not, under strict TypeScript.

---

## 7. `rollup.ts` — raw logs to aggregates

### Why it exists

Detection never touches the `logs` table for counts or latency. It reads
`metrics_rollup` instead, which turns "what did the last hour look like?" from a
scan over hundreds of thousands of rows into a read of sixty.

### Constants

```ts
const MINUTE_MS = 60_000;
const UPSERT_CHUNK_SIZE = 200;
const SERVICE_LEVEL = "";     // sentinel endpoint for the service-wide row
```

### Guarantee 1: idempotent

```ts
.onConflictDoUpdate({
  target: [metricsRollup.service, metricsRollup.endpoint, metricsRollup.bucketStart],
  set: {
    requestCount: sql`excluded.request_count`,
    errorCount:   sql`excluded.error_count`,
    p50Ms:        sql`excluded.p50_ms`,
    p95Ms:        sql`excluded.p95_ms`,
    p99Ms:        sql`excluded.p99_ms`,
  },
})
```

Every write is an upsert keyed on the unique index
`(service, endpoint, bucket_start)` declared back in Phase 0. `excluded` is
SQLite's reference to the row that *would* have been inserted, so a conflict
overwrites with the freshly computed values rather than adding to them.

Two consequences:

- A crashed run can simply be run again. Re-processing a range recomputes
  identical values rather than duplicating or double-counting.
- The worker can **resume by recomputing** the most recent bucket rather than
  having to track exactly where it stopped. That is why the resume logic below is
  three lines instead of a checkpoint table.

### Guarantee 2: only closed minutes

```ts
const to = options.to ?? new Date(floorToMinute(Date.now()));
```

The current, still-filling minute is never written. If it were, a bucket
containing 8 seconds of traffic would look like a 87% traffic collapse to the
detectors — and would fire a false anomaly on **every single run**, forever.

### Resume logic

```ts
let from = options.from;
if (!from) {
  const [lastBucket] = await db
    .select({ value: max(metricsRollup.bucketStart) })
    .from(metricsRollup);

  if (lastBucket?.value) {
    from = lastBucket.value;
  } else {
    const [oldest] = await db.select({ value: min(logs.timestamp) }).from(logs);
    from = oldest?.value ?? undefined;
  }
}

if (!from || from >= to) {
  return { from: from ?? null, to, logsRead: 0, bucketsWritten: 0 };
}
```

Resume from the last written bucket (recomputing it, which is safe), or from the
oldest log on a first run, or do nothing if there is no data. `from >= to` covers
the case where the last bucket *is* the current minute.

### Accumulation

```ts
function accumulate(buckets, service, endpoint, bucketStart, level, latencyMs) {
  const key = bucketKey(service, endpoint, bucketStart);
  let bucket = buckets.get(key);
  if (!bucket) { /* create */ }

  bucket.requestCount += 1;
  if (isErrorLevel(level)) bucket.errorCount += 1;
  if (typeof latencyMs === "number") bucket.latencies.push(latencyMs);
}
```

Note `isErrorLevel` — `error` and `fatal` only. Warnings do **not** inflate the
error rate. This is the Phase 0 distinction between `ERROR_LEVELS` and
`SIGNATURE_LEVELS` paying off: a 404 is not a service failure for rate purposes,
but a *new kind* of 404 is still caught by the signature detector.

The bucket key uses a **NUL separator**:

```ts
return `${service}\0${endpoint}\0${bucketStart}`;
```

NUL cannot occur in a service name or a URL path, so two different
service/endpoint pairs can never collide into one bucket. A naive `-` or `:`
separator could.

### Double accumulation for service-level rows

```ts
accumulate(buckets, row.service, endpoint,      bucketStart, row.level, latencyMs);
accumulate(buckets, row.service, SERVICE_LEVEL, bucketStart, row.level, latencyMs);
```

Each log is accumulated twice — once into its endpoint's bucket, once into a
service-wide bucket with `endpoint = ""`.

**This is necessary because percentiles are not mergeable.** You cannot average
four per-endpoint p95s into a service p95 — that is simply not what a percentile
means. The only correct way to get a service-level p95 is to compute it from the
same raw latencies, which is what the second accumulation does.

Counts *are* mergeable, so this is slight redundancy for those. The alternative —
merging counts in SQL but recomputing percentiles separately — would be two code
paths for one concept.

### Percentile computation and write

```ts
const values = [...buckets.values()].map((bucket) => ({
  bucketStart: new Date(bucket.bucketStart),
  service: bucket.service,
  endpoint: bucket.endpoint,
  requestCount: bucket.requestCount,
  errorCount: bucket.errorCount,
  p50Ms: Math.round(percentile(bucket.latencies, 0.5)),
  p95Ms: Math.round(percentile(bucket.latencies, 0.95)),
  p99Ms: Math.round(percentile(bucket.latencies, 0.99)),
}));
```

Rounded to integers because the schema stores them as integers, and sub-millisecond
precision on a latency percentile is noise.

Writes are chunked at 200 rows to stay well under SQLite's bound-parameter limit
(200 × 8 columns = 1,600 parameters).

### In-memory aggregation, and its limit

The worker reads rows and groups them in JavaScript rather than in SQL. At the
scale this project targets — tens of thousands of rows per run — that is
comfortably fast and keeps the percentile maths in one readable place.

It does not scale indefinitely. At much higher volume the counts would move into a
SQL `GROUP BY` and only the latencies would need to stream out. This is documented
rather than pre-solved, because the simple version is correct today and the
complex version would be unjustified.

### Return value

```ts
export interface RollupResult {
  from: Date | null;
  to: Date | null;
  logsRead: number;
  bucketsWritten: number;
}
```

Returned rather than logged, so the caller decides how to present it. The CLI
prints it; a future scheduled worker might emit it as a metric.

---

## 8. `engine.ts` — loading, orchestration, persistence

Everything the pure detectors deliberately do not do. It contains **no detection
logic of its own** — that separation is what keeps the provable part provable.

### `collectSignatures`

```ts
function collectSignatures(
  rows: readonly { errorSignature: string | null; message: string }[],
): Map<string, SignatureOccurrence> {
  const signatures = new Map<string, SignatureOccurrence>();
  for (const row of rows) {
    if (!row.errorSignature) continue;
    const existing = signatures.get(row.errorSignature);
    if (existing) {
      existing.occurrences += 1;
    } else {
      signatures.set(row.errorSignature, {
        occurrences: 1,
        sampleMessage: row.message,   // first raw message seen
      });
    }
  }
  return signatures;
}
```

Collapses raw error rows into per-signature counts, keeping the **first** raw
message as the sample. First rather than last is arbitrary but deterministic —
and determinism matters, because it means the same window always produces the
same trigger, which is what makes the Phase 2 classifier's input reproducible.

### `loadWindowStats`

Two queries. The first reads the service-level rollup buckets in range:

```ts
.where(and(
  eq(metricsRollup.service, service),
  eq(metricsRollup.endpoint, SERVICE_LEVEL),   // the "" sentinel
  gte(metricsRollup.bucketStart, windowStart),
  lt(metricsRollup.bucketStart, windowEnd),
))
```

`gte` / `lt` — half-open interval. Adjacent windows therefore never double-count
the boundary minute.

The second reads error rows for signatures:

```ts
.where(and(
  eq(logs.service, service),
  isNotNull(logs.errorSignature),
  gte(logs.timestamp, windowStart),
  lt(logs.timestamp, windowEnd),
))
```

`isNotNull(logs.errorSignature)` is why this query is cheap despite hitting the
raw log table: in the seeded baseline it excludes ~99% of rows, and there is an
index on `(service, error_signature)`.

Then the aggregation:

```ts
return {
  service,
  minutes: Math.max(buckets.length, 1),
  requestCount: buckets.reduce((sum, b) => sum + b.requestCount, 0),
  errorCount: buckets.reduce((sum, b) => sum + b.errorCount, 0),
  p95Ms: mean(buckets.map((b) => b.p95Ms)),
  p99Ms: mean(buckets.map((b) => b.p99Ms)),
  signatures: collectSignatures(errorRows),
};
```

**Window p95 is the mean of per-minute p95s, not the max.** This is a real
trade-off, stated plainly: averaging dilutes a single spiking minute across five,
so a one-minute blip may not cross the ratio threshold. That is accepted — Tier
1's job is to be cheap and quiet, and a one-minute blip is exactly the sort of
thing that should not page anyone. The consequence is documented in §16.

(Strictly, a mean of p95s is not itself a p95 of the union. It is a
well-behaved and stable summary of tail latency across the window, which is what
the ratio test needs.)

### `loadBaselineStats`

Same shape, but keeps **per-minute arrays** rather than summing:

```ts
return {
  errorCountsPerMinute: buckets.map((b) => b.errorCount),
  p95PerMinute: buckets.map((b) => b.p95Ms),
  signatures,
  minutes: buckets.length,
};
```

This is what lets the detectors compute spread. A pre-summed baseline could not
produce a standard deviation.

Baseline signatures use `selectDistinct` — only membership matters, not counts,
so there is no reason to transfer duplicates.

Note `minutes: buckets.length` **without** a `Math.max(..., 1)` floor, unlike the
window. That is deliberate: a baseline of zero minutes must read as zero so the
`minBaselineMinutes` guard can catch it.

### `mergeTriggers`

```ts
function mergeTriggers(existing, incoming): AnomalyTrigger[] {
  const byKind = new Map<AnomalyTrigger["kind"], AnomalyTrigger>();
  for (const trigger of existing) byKind.set(trigger.kind, trigger);
  for (const trigger of incoming) byKind.set(trigger.kind, trigger);
  return [...byKind.values()];
}
```

Keyed by `kind`, incoming written second so it wins. An extended anomaly
therefore carries the **most recent** evidence of each kind rather than the
stalest — if an incident worsens, the trigger reflects the worse numbers.

### `persistAnomaly`

```ts
const mergeCutoff = new Date(windowStart.getTime() - config.anomalyMergeGapMinutes * MINUTE_MS);

const [openAnomaly] = await db.select({ /* ... */ })
  .from(anomalies)
  .where(and(
    eq(anomalies.service, service),
    eq(anomalies.status, "open"),
    gte(anomalies.windowEnd, mergeCutoff),
  ))
  .orderBy(desc(anomalies.windowEnd))
  .limit(1);
```

Three conditions: same service, still `open`, and ended recently enough. Ordered
newest-first so the most recent open anomaly wins if several somehow qualify.

On a hit, extend:

```ts
await db.update(anomalies).set({
  windowEnd: windowEnd > openAnomaly.windowEnd ? windowEnd : openAnomaly.windowEnd,
  triggers: mergeTriggers(openAnomaly.triggers, triggers),
  detectedAt: new Date(),
}).where(eq(anomalies.id, openAnomaly.id));
```

`windowEnd` takes the max, so a later run cannot accidentally shrink the incident
window. `windowStart` is never touched — the incident began when it began.

Otherwise insert, with `.returning({ id })` so the caller gets the new id:

```ts
const [created] = await db.insert(anomalies).values({
  detectedAt: new Date(),
  windowStart, windowEnd, service, triggers,
  status: "open",
}).returning({ id: anomalies.id });

if (!created) throw new Error("failed to insert anomaly");
```

**`severity`, `summary` and `is_real_incident` are not set at all.** They stay
`null`. An anomaly is a complete, valid record with zero LLM involvement — the
schema's nullable Tier 2 columns are the two-tier design expressed structurally.

### `runDetection` — window anchoring

```ts
const [latest] = await db.select({ value: max(metricsRollup.bucketStart) }).from(metricsRollup);
const latestBucket = latest?.value;
const windowEndMs = latestBucket
  ? latestBucket.getTime() + MINUTE_MS
  : floorToMinute(options.now?.getTime() ?? Date.now());

const windowEnd     = new Date(windowEndMs);
const windowStart   = new Date(windowEndMs - config.windowMinutes * MINUTE_MS);
const baselineEnd   = new Date(windowStart.getTime() - config.baselineGapMinutes * MINUTE_MS);
const baselineStart = new Date(baselineEnd.getTime() - config.baselineMinutes * MINUTE_MS);
```

The window ends at the most recent **closed minute present in the rollups**, not
at `Date.now()`. This keeps detection and the rollup worker from disagreeing
about where "now" is — otherwise detection would routinely evaluate a window
whose final minute the rollup worker had deliberately not written yet, see zero
traffic there, and misread it.

`+ MINUTE_MS` because `windowEnd` is exclusive and `latestBucket` is the *start*
of the last complete minute.

The resulting timeline:

```
      baselineStart          baselineEnd  windowStart      windowEnd
            │                     │            │                │
            ├─────── 60 min ──────┤── 1 min ───┤──── 5 min ─────┤
                  baseline           gap            window
```

This anchoring has a known consequence — see §16.

### `runDetection` — the per-service loop

```ts
const serviceRows = await db.selectDistinct({ service: metricsRollup.service })
  .from(metricsRollup)
  .where(gte(metricsRollup.bucketStart, baselineStart));
```

Only services with recent data. A service decommissioned last year does not get
evaluated forever.

For each service, **baseline first**:

```ts
const baseline = await loadBaselineStats(service, baselineStart, baselineEnd);

if (baseline.minutes < config.minBaselineMinutes) {
  results.push({ /* ... */ skippedReason:
    `only ${baseline.minutes} min of baseline (need ${config.minBaselineMinutes})` });
  continue;
}
```

Baseline is loaded before the window so an under-baselined service costs one
query instead of three. The skip carries a **reason**, so the CLI can say
`skipped — only 12 min of baseline (need 30)` rather than looking identical to
"clean". Those two states are very different and conflating them would make the
tool untrustworthy.

Then window, detect, and persist only if something fired.

### Return type

```ts
export interface ServiceDetectionResult {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: AnomalyTrigger[];
  action: "created" | "extended" | "none";
  anomalyId: string | null;
  skippedReason?: string;
}
```

`action` distinguishes the three outcomes explicitly rather than making the caller
infer them from `anomalyId` being null.

---

## 9. `cli.ts` — the operator interface

Deliberately a **one-shot command rather than a daemon**. Detection is idempotent
and cheap, so running it on an interval from outside (or via `--watch`) keeps the
moving parts obvious while developing. There is no scheduler state to reason
about, and no long-lived process to leak.

### Commands

| Flag | Effect |
|---|---|
| *(none)* | Roll up, then detect, once |
| `--rollup-only` | Recompute aggregates and stop |
| `--detect-only` | Run detectors against existing rollups |
| `--watch <sec>` | Repeat every `<sec>` seconds |
| `-h`, `--help` | Usage, including current thresholds |

`--rollup-only` and `--detect-only` exist because they separate two questions when
something looks wrong: "is the data being aggregated correctly?" and "are the
detectors reading it correctly?"

The help text prints live config values:

```ts
window ${detectionConfig.windowMinutes} min | baseline ${detectionConfig.baselineMinutes} min |
k=${detectionConfig.errorRate.stdDevMultiplier} | latency ratio ${detectionConfig.latency.ratioThreshold}x
```

so `--help` cannot drift out of date with `config.ts`.

### Trigger formatting

```ts
function describeTrigger(trigger: AnomalyTrigger): string {
  switch (trigger.kind) {
    case "error_rate_spike":   return `...z=${trigger.zScore}`;
    case "latency_jump":       return `...(${trigger.ratio}x)`;
    case "new_error_signature":return `..."${trigger.signature}" x${trigger.occurrences}`;
  }
}
```

An exhaustive `switch` over the discriminated union with **no `default` case**.
Combined with `noFallthroughCasesInSwitch`, adding a fourth trigger kind becomes a
compile error here — the formatter cannot silently omit a new detector.

### Output

Three distinct states, never conflated:

```
  orders-api: clean
  orders-api: skipped — only 12 min of baseline (need 30)
  orders-api: ANOMALY created  6a185278
    - error_rate_spike     211 errors in window; baseline 0.33/min ±0.6, z=69.62
    - new_error_signature  "TypeError: ... (reading <str>)" x210
                       sample: TypeError: ... (reading 'toFixed')
```

### `--watch`

```ts
let running = true;
process.on("SIGINT", () => { running = false; console.log("\nStopping."); });

while (running) {
  await runOnce(rollupOnly, detectOnly);
  await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
}
```

Ctrl-C sets a flag rather than killing mid-run, so a detection pass finishes
cleanly instead of being interrupted between the detector firing and the anomaly
being written.

---

## 10. The tests

27 tests, 6ms, run with `pnpm test`.

### They use the real config

```ts
import { detectionConfig } from "./config";
const config = detectionConfig;
```

Not a fixture. If someone changes `stdDevMultiplier` from 3 to 1, the suite fails
rather than silently making the whole system three times more sensitive in
production. The tests are as much a guard on the *thresholds* as on the code.

Some tests assert on config directly, to keep the intent honest:

```ts
expect(config.newSignature.minOccurrences).toBeGreaterThan(2);
```

### Fixture builders

```ts
/** 60 minutes cycling 1..6: mean 3.5, sample stddev ~1.72, threshold ~8.66. */
const NOISY_ERROR_BASELINE = Array.from({ length: 60 }, (_, i) => (i % 6) + 1);
```

A deliberately *noisy* baseline. A flat one would mean every "does not fire" test
passed because of the absolute floor rather than the statistical test — the test
would look green while proving nothing about the maths.

### What is covered

**`stats.test.ts`** — empty-set guards returning 0 rather than NaN; sample vs
population formula (asserting 1.5811, not 1.4142); percentile sorting,
interpolation and clamping; and median-vs-mean outlier robustness with concrete
numbers.

**`detectors.test.ts`** — for each detector: fires, does not fire within normal
variation, respects its absolute floor, and handles a degenerate baseline. Plus:

- **z-score JSON round-trip** — `JSON.parse(JSON.stringify(trigger)).zScore` equals
  the original, proving the `Infinity` clamp works where it matters.
- **Median robustness** — the 55×60ms + 5×5000ms baseline, asserting
  `baselineMs === 60`.
- **Most-frequent selection** — two novel signatures, asserting the dominant one is
  reported.
- **`runDetectors` returning all three** — one window that trips everything.

The floor tests are written to isolate the floor from the statistical test. For
example:

```ts
it("respects the absolute floor even when the baseline is perfectly flat", () => {
  const trigger = detectErrorRateSpike(
    makeWindow({ errorCount: 5 }),                                     // 1/min
    makeBaseline({ errorCountsPerMinute: Array.from({ length: 60 }, () => 0) }),
    config,
  );
  expect(trigger).toBeNull();
});
```

A zero baseline means any error is infinitely many sigma out. The *only* thing
that can make this return null is the floor.

---

## 11. End-to-end walkthrough of one run

What `pnpm detect` actually does.

**1. Rollup resumes.** Query `max(bucket_start)` from `metrics_rollup`. Say
`08:27`. Set `to = floorToMinute(now)` — say `08:29`.

**2. Read raw logs** in `[08:27, 08:29)`. Say 564 rows.

**3. Accumulate** into a Map. Each row lands in two buckets: its endpoint's and
the service-level `""`. With 4 endpoints × 2 minutes × 2 (endpoint + service) ≈ 8
buckets.

**4. Compute percentiles** per bucket from its collected latencies; round.

**5. Upsert** 8 rows. Bucket `08:27` already existed and is overwritten with the
same or fuller values — harmless, by design.

**6. Anchor the window.** `max(bucket_start)` is now `08:28`, so
`windowEnd = 08:29`, `windowStart = 08:24`, `baselineEnd = 08:23`,
`baselineStart = 07:23`.

**7. List services** with any bucket since `07:23` → `["orders-api"]`.

**8. Load baseline** for `[07:23, 08:23)` — 60 per-minute error counts, 60
per-minute p95s, and the distinct signature set. `minutes = 60`, above the
threshold of 30, so proceed.

**9. Load window** for `[08:24, 08:29)` — 5 buckets summed to totals, p95 averaged,
and error rows collapsed into a signature map.

**10. Run detectors.** Each returns a trigger or null; nulls are filtered out.

**11. Persist.** Look for an open anomaly for `orders-api` with
`window_end >= 08:14`. Found → extend its `window_end` to `08:29` and merge
triggers. Not found → insert a new row with `status = "open"` and Tier 2 columns
null.

**12. Report.** The CLI prints the window, then one line per service, plus a line
per trigger.

---

## 12. Worked example with real numbers

From the actual verification run — the `new-error` case.

**Baseline** (60 minutes of healthy traffic):

```
baselineMean   = 0.32 errors/min
baselineStdDev = 0.60
threshold      = 0.32 + 3 × 0.60 = 2.12 errors/min
```

**Window** (5 minutes, with the injection):

```
errorCount        = 211
observedPerMinute = 211 / 5 = 42.2
```

**Floor check:** `42.2 >= 2` ✓

**Threshold check:** `42.2 > 2.12` ✓ → fires

**z-score:** `(42.2 − 0.32) / 0.60 = 69.8` — reported as `69.62` (the small
difference is `toFixed(2)` rounding of the underlying unrounded mean and σ, which
are stored rounded but computed full-precision).

Simultaneously, the signature detector:

```
window signatures:   { "TypeError: ... (reading <str>)" → 210 occurrences }
baseline signatures: { "Order <num> not found",
                       "Rate limit exceeded for client <num>",
                       "Upstream timeout ... after <num>ms" }
```

`TypeError...` is absent from the baseline, and 210 ≥ 3 → fires.

The latency detector does **not** fire: this scenario does not change latency, so
window p95 stays near baseline and the ratio is well under 3.

**Result:** one anomaly with two triggers. Correct — that scenario genuinely
creates both conditions.

### The same baseline, `error-spike` case

```
errorCount = 81  →  81 / 5 = 16.2/min  →  16.2 > 2.12  ✓  z = 26.63
```

Fires the error-rate detector only. The signature detector does not fire because
that scenario **reuses errors already in the baseline** — which is precisely what
it was designed to verify.

### The `latency-jump` case

```
window p95   = 1232 ms
baseline p95 = 163 ms  (median of 60 per-minute p95s)
ratio        = 7.56
```

`1232 >= 200` ✓ and `7.56 >= 3` ✓ → fires. The error-rate detector does not,
because that scenario leaves the error rate untouched.

**These three cases together are what demonstrate the detectors are independent**,
not three views of the same signal.

---

## 13. The statistics, explained

### 13.1 Why `mean + k·σ` rather than a fixed threshold

A fixed threshold ("alert above 50 errors/min") requires knowing what normal
looks like for every service, breaks when traffic grows, and has to be retuned by
hand forever.

`mean + k·σ` asks a different question: *is this unusual for this service?* The
baseline supplies "normal" and the standard deviation supplies "how much variation
is routine". A service that normally sees 40 errors/min with high variance will
not fire at 60; a service that normally sees 0.3 with low variance will.

`k = 3` corresponds to ~99.7% of a normal distribution. Error counts are not
normally distributed — they are counts, bounded below at zero and usually
right-skewed — so this is a heuristic rather than a probability guarantee. It is a
reasonable and conventional one, and the absolute floor covers the cases where the
normality assumption is worst.

### 13.2 Why median for latency baseline but mean for error baseline

They answer different questions.

The **error** baseline needs *spread*, and standard deviation is defined around a
mean. Using a median there would mean mixing a robust centre with a non-robust
spread.

The **latency** baseline needs only a *centre* for the ratio, and latency baselines
are far more likely to contain contaminating spikes — a deploy, a cold cache, a
neighbour on the same host. Using the mean would let a spike already present in the
baseline raise the bar, making the detector least sensitive exactly when a service
has recently been misbehaving. That is a genuinely bad failure mode, so the median
is the right centre here.

Concretely, from the test:

| Baseline | Mean | Median |
|---|---:|---:|
| 55 min @ 60ms + 5 min @ 5000ms | ~470ms | 60ms |

Against a 300ms window: mean gives ratio 0.64 (silent), median gives 5.0 (fires).

### 13.3 Why absolute floors are not a hack

They look like fudge factors. They are not — they correct a real failure of the
statistical model at the boundary.

`mean + k·σ` assumes σ is a meaningful measure of variation. On a service with
zero errors every minute for an hour, σ = 0 and **every** positive value is
infinitely many standard deviations out. The model has no opinion left; it
degenerates.

Without a floor, the detector would be loudest on the services behaving best —
the exact opposite of useful. The floor says: below this level, the statistical
question is not worth asking. It is a statement about practical significance,
which statistical significance cannot express.

The verification run makes this concrete: with baseline mean 0.32 and σ = 0.60,
the 3σ threshold is 2.12/min — essentially the same as the hardcoded floor of
2/min. **On a service this quiet, the floor is doing most of the work.** The
statistical test only starts earning its keep on noisier services. That is worth
knowing rather than glossing over.

### 13.4 Why interpolated percentiles

Nearest-rank percentile on N samples can only return one of the N observed values.
At small N, p95 therefore jumps between two specific values minute to minute,
inflating the standard deviation of the baseline and producing false positives.
Interpolation gives a continuous estimate, a tighter baseline, and fewer spurious
alerts.

---

## 14. Design decisions and trade-offs

| Decision | Rationale | Trade-off accepted |
|---|---|---|
| **Pure detectors, impure engine** | Detection logic can be proven with fixed inputs | One extra translation layer in `engine.ts` |
| **Config injected, not imported** | Tests can vary thresholds; future UI can display them | Slightly more verbose signatures |
| **Relative threshold + absolute floor** | Adapts per service, without degenerating on quiet ones | Two numbers to tune per detector instead of one |
| **Median for latency baseline** | Spikes in the baseline cannot suppress detection | Inconsistent with the error baseline's mean (justified in §13.2) |
| **Mean of per-minute p95 for the window** | Stable, resists one-minute noise | A single spiking minute may be missed (§16) |
| **Rollups, not raw scans** | 60-row read instead of 100k-row scan | An extra table and a worker to keep current |
| **Service-level rows computed, not derived** | Percentiles are not mergeable | Each log accumulated twice |
| **Idempotent upserts** | Crashed runs are simply re-run; no checkpoint table | Recomputes the last bucket each run |
| **Only closed minutes** | A partial bucket would fire a false anomaly every run | Detection lags real time by up to a minute |
| **Dedupe by extension** | One incident is one anomaly; also caps Phase 2 LLM cost | A genuinely new incident within 10 min merges into the old one |
| **z-score clamped to 999** | `JSON.stringify(Infinity)` is `null` and would corrupt storage | The number is synthetic at the boundary |
| **All triggers returned, not the first** | One incident sets off several; each is evidence | Slightly larger `triggers` payload |
| **One-shot CLI, not a daemon** | No scheduler state, no long-lived process | External scheduling needed in production |
| **In-memory aggregation** | Simple, fast at target scale, percentile maths in one place | Would need to move into SQL at much higher volume |

---

## 15. Verification results

### Unit tests

```
 Test Files  2 passed (2)
      Tests  27 passed (27)
   Duration  6ms
```

### End to end

Each case against a freshly reset database: 120 minutes of healthy backfill, then
the injection, then `pnpm detect`.

| Case | Expected | Actual |
|---|---|---|
| Healthy baseline only | clean | **clean, 0 anomalies** ✓ |
| `inject error-spike` | error rate only | `error_rate_spike`, z=26.63 ✓ |
| `inject latency-jump` | latency only | `latency_jump`, 1232ms vs 163ms (7.56x) ✓ |
| `inject new-error` | signature (+rate) | `error_rate_spike` + `new_error_signature` ×210 ✓ |

**The first row is the most important result.** A detector that fires on healthy
traffic is worse than no detector, because it trains people to ignore it.

**The last row firing two detectors is correct, not a bug.** The `new-error`
scenario raises the error rate to 30% *and* introduces a novel signature, so both
conditions genuinely hold. The middle two rows each firing only their own detector
is what proves the three are independent.

### Dedupe

Running detection twice on unchanged data:

```
run 1:  orders-api: ANOMALY created   6a185278    window 08:23 → 08:28
run 2:  orders-api: anomaly extended  6a185278    window 08:23 → 08:29
```

Same id, window extended, row count still 1.

### Stored row

```
              id = 6a185278-45df-4883-9326-09291a19bfe0
         service = orders-api
          status = open
        severity = (null)
         summary = (null)
is_real_incident = (null)
    window_start = 2026-07-29 08:23:00
      window_end = 2026-07-29 08:29:00
```

Tier 2 columns null, as designed. The `triggers` JSON round-trips with all fields
and a finite z-score intact.

---

## 16. Known limitations

Stated rather than hidden, because they shape what Phase 2 has to handle.

### Silence is not detected

Because the window anchors to the latest bucket *containing data*, a service that
stops logging entirely **freezes detection instead of raising an alarm**. The
window stops advancing, and the last evaluated window keeps looking normal.

A dead service is arguably the most severe incident there is, and Tier 1 currently
cannot see it. The fix is a fourth detector — traffic drop / absence — comparing
recent request counts against the baseline, with an explicit "no data at all"
branch. It is cheap to add; it is simply not in this phase.

### A single spiking minute is diluted

Window p95 is the mean of per-minute p95s over 5 minutes, so a one-minute latency
spike is averaged down by 5x and may not cross the ratio threshold. Accepted
trade-off for quietness, but it means brief spikes are not Tier 1's to catch.

### Only the most frequent novel signature is reported

When several novel signatures appear at once, the others are still present in the
anomaly's log window but are not called out in the trigger. Enough for the
classifier, potentially less than ideal for a dashboard.

### The floor dominates on quiet services

As shown in §13.3, on a service with baseline 0.32 errors/min the 3σ threshold
(2.12) and the absolute floor (2) are nearly identical. The statistical machinery
is not contributing much there. This is correct behaviour but worth knowing when
interpreting results.

### In-memory aggregation

The rollup worker groups rows in JavaScript. Fine at tens of thousands of rows per
run; would need to move into SQL at much higher volume.

### Anomaly status is never advanced automatically

Nothing sets `dismissed` or `resolved` yet. Anomalies stay `open`, which also
means the dedupe window keeps extending them. Later phases own that lifecycle.

---

## 17. Running and tuning

### Commands

```bash
pnpm detect                  # roll up, then detect, once
pnpm detect --watch 30       # repeat every 30 seconds
pnpm detect --rollup-only    # recompute aggregates only
pnpm detect --detect-only    # detect against existing rollups
pnpm detect --help           # usage, including current thresholds
pnpm test                    # 27 unit tests
```

### Full demo from scratch

```bash
lsof -ti:4000 | xargs kill -9      # stop any old server
rm -f data/dev.db*
pnpm db:push
pnpm backend                        # terminal 1

pnpm generate backfill --minutes 120
pnpm detect                         # expect: clean

pnpm generate inject --scenario new-error --minutes 5
pnpm detect                         # expect: ANOMALY created
```

### Inspecting results

```bash
sqlite3 -line data/dev.db "
  SELECT id, service, status, severity,
         datetime(window_start/1000,'unixepoch') AS window_start,
         datetime(window_end/1000,'unixepoch')   AS window_end
  FROM anomalies;"

sqlite3 data/dev.db "SELECT json_pretty(triggers) FROM anomalies;"

sqlite3 -header -column data/dev.db "
  SELECT datetime(bucket_start/1000,'unixepoch') AS minute,
         request_count, error_count, p50_ms, p95_ms, p99_ms
  FROM metrics_rollup
  WHERE endpoint = '' ORDER BY bucket_start DESC LIMIT 10;"
```

### Tuning

Everything is in `packages/backend/src/detection/config.ts`.

| Symptom | Adjust |
|---|---|
| Too many false positives | Raise `stdDevMultiplier` (3 → 4) or the absolute floors |
| Missing real incidents | Lower `stdDevMultiplier` or `latency.ratioThreshold` |
| Slow to notice | Lower `windowMinutes` (5 → 2) |
| Noisy, jumpy detection | Raise `windowMinutes` or `baselineMinutes` |
| Anomalies fragmenting | Raise `anomalyMergeGapMinutes` |
| One incident spanning too much | Lower `anomalyMergeGapMinutes` |

After changing anything, run `pnpm test` — several tests assert against the real
config and will tell you if a change contradicts a documented assumption.

---

## What Phase 1 hands to Phase 2

Rows in `anomalies` with `status = "open"`, a populated `triggers` array, correct
window boundaries, and three null columns — `severity`, `summary`,
`is_real_incident` — waiting to be filled by the LLM classifier.

The dedupe logic means each incident is one row rather than one per detection run,
which directly bounds how many LLM calls Phase 2 will make. Tier 1 does not just
find anomalies; it controls what Tier 2 costs.
