# The Codebase — Complete Reference

Everything the system is, in one document: the architecture, the design
principles behind it, the data model, and every source file — what it does, what
it exports, and why it is built that way.

The other reference documents are **phase-ordered**, so each describes the system
as it stood at the end of a phase and some of what they say has been superseded.
This one describes the system **as it is now**. Where they disagree, this file and
the code win.

**Size:** 44 TypeScript files — 5,112 lines of source, 1,010 lines of tests.

---

## Contents

**Part I — The system**
[1. What it does](#1-what-it-does) ·
[2. The pipeline](#2-the-pipeline) ·
[3. Seven principles](#3-seven-principles-that-explain-everything-else) ·
[4. The data model](#4-the-data-model)

**Part II — How things actually flow**
[5. Life of a log line](#5-life-of-a-log-line) ·
[6. Life of a detection run](#6-life-of-a-detection-run) ·
[7. Life of a classification](#7-life-of-a-classification) ·
[7a. Life of a correlation](#7a-life-of-a-correlation)

**Part III — Every file**
[8. shared](#8-packagesshared) ·
[9. generator](#9-packagesgenerator) ·
[10. backend: foundation](#10-backend--foundation) ·
[11. backend: detection](#11-backend--detection-tier-1) ·
[12. backend: llm](#12-backend--llm) ·
[13. backend: classification](#13-backend--classification-tier-2) ·
[14. backend: eval](#14-backend--eval) ·
[14a. backend: correlation](#14a-backend--correlation-phase-3-partial)

**Part IV — Reference**
[15. Algorithms](#15-the-algorithms) ·
[16. Configuration](#16-configuration) ·
[17. Commands](#17-commands) ·
[18. Testing](#18-testing-strategy) ·
[19. Limitations](#19-known-limitations) ·
[20. Not built](#20-what-is-not-built)

---

# Part I — The system

## 1. What it does

A monitored application emits structured logs. The system ingests them, finds
anomalies statistically, uses an LLM to judge whether those anomalies actually
matter, and — in phases not yet built — correlates the real ones with recent git
commits and proposes a fix.

The point is not "call an LLM on some logs." The point is the funnel: cheap
statistics handle the obvious cases at zero cost, and the model is invoked only
where semantic understanding earns its price.

## 2. The pipeline

```
  monitored app
       │  HTTP POST, batches of structured log entries
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  POST /ingest          validate (Zod) → normalise signature   │
  │                        → insert. Nothing else.                │
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
                      ┌─────────────┐
                      │  logs       │  raw entries, indexed (service, timestamp)
                      └──────┬──────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  rollup worker         raw logs → per-minute aggregates       │
  │                        idempotent upserts, closed minutes only│
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │ metrics_rollup  │  counts + p50/p95/p99 per minute
                    └────────┬────────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  TIER 1 — detection engine                    no LLM, no cost │
  │                                                               │
  │  window = last 5 closed minutes                               │
  │  baseline = the 60 minutes before it (1-minute gap)           │
  │                                                               │
  │    error_rate_spike     errors/min > mean + 3σ                │
  │    latency_jump         p95 ≥ 3× baseline median p95          │
  │    new_error_signature  signature absent from baseline         │
  │                                                               │
  │  fires → create anomaly, or extend a recent one               │
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
                      ┌─────────────┐
                      │  anomalies  │  severity/summary NULL = unclassified
                      └──────┬──────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  TIER 2 — LLM classifier              ~1 call per incident    │
  │                                                               │
  │  build packet: totals, per-minute, per-endpoint, ~23 lines     │
  │    → provider.complete()                                      │
  │    → extract JSON → Zod parse → repair ×2 if invalid          │
  │                                                               │
  │  severity · summary · isRealIncident · affectedArea           │
  └───────────┬──────────────────────────────┬───────────────────┘
              │ real                          │ benign
              ▼                               ▼
        status stays open                status = dismissed
              │                          (never correlated)
              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  PHASE 3 — commit correlation         ~1 call per incident    │
  │                                                               │
  │  git log --numstat over the target repo, bounded:             │
  │    48h back, 25 commits, --until = end of the window          │
  │                                                               │
  │  build packet: the incident + the candidates side by side     │
  │    → provider.complete()                                      │
  │    → Zod parse → GROUND against the candidate list            │
  │         invented sha  → fail, write nothing                   │
  │         invented file → drop it, report it                    │
  │                                                               │
  │  suspectedCommitSha (nullable) · confidence · reasoning       │
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │  correlations   │  a null sha is still a row —
                    │                 │  "declined" ≠ "never ran"
                    └────────┬────────┘
                             ▼
                     status = correlated
                             │
                             ▼
                      ┌─────────────┐
                      │  llm_calls  │  tokens, latency, repairs, success
                      └─────────────┘         attributed per agent
```

Two things flow alongside: the **generator** produces synthetic traffic (healthy
baselines and nine injectable scenarios), and the **eval harness** scores the
classifier against captured golden cases. There is no correlation eval yet.

The funnel narrows twice. Tier 2 only sees what Tier 1 raised; correlation only
sees what Tier 2 called real. Every dismissed window is a `git log` and a model
call that never happened.

## 3. Seven principles that explain everything else

Almost every decision in the codebase follows from one of these.

**1 · Two tiers, and the cheap one must work alone.**
Statistics are free and good at "this number is unusual." The model is only worth
paying for where reading is required. So `pnpm detect` never calls a model,
classification is a separate command, and the default provider is an offline
stub. The statistical layer working on its own is a property that is kept
checkable, not just claimed.

**2 · Pure logic is separated from I/O.**
In every module, the code that *decides* has no database, clock, or network:
`detectors.ts`, `stats.ts`, `context.ts`, `structured.ts`, `json.ts`,
`grounding.ts`, `score.ts`. The code that *persists* is separate: `engine.ts`,
`rollup.ts`, `classify.ts`, `calls.ts`. This is why 162 tests run in ~300 ms with
no fixtures. **When hunting for logic, it is in a pure file.**

**3 · Everything crossing a boundary is validated with Zod.**
Incoming logs at ingest, model output at classification, golden cases at load.
Nothing downstream ever consumes unvalidated data, and a malformed thing fails at
the boundary — loudly — rather than three functions later as an `undefined`.

**4 · Every threshold is a ratio *and* a floor.**
The ratio adapts to each service; the floor corrects for statistics misbehaving
at small numbers. A quiet service has near-zero variance, making one extra error
a >3σ event; latency moving 2 ms → 8 ms is a 4× regression nobody can perceive.

**5 · Normalise, then compare.**
Variable detail (ids, timestamps, quoted values) is stripped so recurring
failures collapse onto a stable key. This single idea powers two things: the
new-signature detector, and the evidence sampler that shows the model one example
per distinct message shape.

**6 · Declining is a first-class answer.**
Tier 2 can rule that a flagged window is not an incident; the correlator can
rule that no commit explains it. Both are recorded rather than treated as
absence — a declined correlation still writes a row, so "considered and
declined" stays distinguishable from "never ran". This is why
`suspectedCommitSha` is nullable, why `affectedArea` offers `"unknown"`, why
half the generator's scenarios are benign, and why the eval scorecard reports
benign and incident accuracy separately. A model with no way to decline invents
something.

**7 · State the trade-off; don't hide it.**
Every design-decision table in the docs has a "costs" column, limitations are
listed rather than omitted, and the eval publishes a negative result about the
project's own central claim.

**Where 5 and 6 pull against each other.** Normalisation is what makes detection
work and what makes correlation harder: `reading '<str>'` matches nothing in a
repository. The correlation packet prints the raw sample alongside the collapsed
shape for exactly that reason — the same idea serving one stage and obstructing
the next is worth knowing about before it surprises you.

## 4. The data model

Six tables, all defined in `packages/backend/src/db/schema.ts`. SQLite today,
deliberately Postgres-shaped: timestamps are epoch milliseconds and JSON is text
— SQLite's equivalents of `timestamptz` and `jsonb` — so migrating means swapping
the column builders in that one file and the driver in `client.ts`.

**`logs`** — raw entries, the only write path in the hot path.

| Column | Notes |
|---|---|
| `id` | UUID, generated app-side |
| `timestamp` | epoch ms |
| `service`, `level`, `message` | level is `info \| warn \| error \| fatal` |
| `error_signature` | normalised; NULL for `info`. Computed at write time |
| `metadata` | JSON — requestId, endpoint, method, statusCode, latencyMs, errorType, stack, plus anything else |

Indexed on `(service, timestamp)` because every detection query is time-windowed,
and on `(service, error_signature)` to make new-signature lookup an index hit
rather than a regex scan over millions of rows.

**`metrics_rollup`** — per-minute aggregates.

| Column | Notes |
|---|---|
| `bucket_start` | minute boundary, epoch ms |
| `service`, `endpoint` | `endpoint = ""` is the sentinel for the service-wide row |
| `request_count`, `error_count` | |
| `p50_ms`, `p95_ms`, `p99_ms` | |

Unique index on `(service, endpoint, bucket_start)` — this is what makes the
rollup worker idempotent.

**`anomalies`** — Tier 1 output, enriched by Tier 2.

| Column | Written by |
|---|---|
| `detected_at`, `window_start`, `window_end`, `service` | Tier 1 |
| `triggers` | Tier 1 — JSON array of which signals fired, with their evidence |
| `severity`, `summary`, `is_real_incident` | Tier 2 — **NULL means unclassified** |
| `affected_area` | Tier 2 — added in Phase 3. The classifier had produced this field since Phase 2 and nothing wrote it down; correlation is the first consumer that needs it later than the call that produced it |
| `status` | `open \| correlated \| diagnosed \| dismissed \| resolved` |

The NULL columns are the handoff contract between tiers. "Unclassified" is
`severity IS NULL`, not a status value, so an anomaly is never classified twice
however its status later moves.

**`correlations`** and **`hypotheses`** — Phases 3 and 4. Defined, unused. The
`applied` column on `hypotheses` defaults to `false` and stays there: the agent
diagnoses, a human decides.

**`llm_calls`** — one row per model invocation: provider, model, agent, input and
output tokens, latency, repair attempts, success. Failures included, since those
spend quota too. This table is what substantiates the cost claim.

---

# Part II — How things actually flow

Reading these three walkthroughs teaches the system faster than the file list
that follows.

## 5. Life of a log line

1. The generator (or a real app) POSTs a batch to `/ingest`.
2. `envelopeSchema` validates the outer shape only — an array of 1–1000 unknowns.
   A malformed envelope is a 400.
3. Each entry is validated **individually** against `logEntrySchema`. Invalid ones
   are collected with their index and reason; valid ones become rows. One bad
   entry in 500 does not cost the other 499.
4. For `warn`/`error`/`fatal`, `normalizeErrorSignature(message)` runs and the
   result is stored on the row. `info` gets NULL.
5. Rows insert in chunks of 250 to stay under SQLite's bound-parameter cap.
6. Response is **202** if everything was accepted, **207** if some was rejected,
   with per-index reasons (capped at 20).

Note what does *not* happen: no detection, no enrichment, no branching on
content. Computing the signature here is the one deliberate exception — it is a
pure O(1) string transform, and precomputing it converts the new-signature
detector from a scan into an indexed lookup.

## 6. Life of a detection run

`pnpm detect` runs rollup then detection, once.

**Rollup:** resumes from the most recent bucket already written (recomputing that
bucket, which is safe because writes are upserts), or from the oldest log if
there are none. Reads the range into memory, buckets by minute, and computes
counts and percentiles. Writes both a per-endpoint row and a service-wide row —
percentiles are not mergeable, so the service aggregate is computed from the same
raw latencies rather than averaged from endpoint rows. Only **closed** minutes
are written; a partially-filled current minute would look like a traffic collapse
and fire a false anomaly every run.

**Detection:** the window ends at the most recent closed minute *present in the
rollups* rather than at `Date.now()`, so detection and the rollup worker cannot
disagree about where "now" is. Window is the 5 minutes before that; baseline is
the 60 minutes before the window, with a 1-minute gap so the window's own data
cannot leak into the baseline it is judged against.

For each service with rollup data:
- If less than 30 minutes of baseline exists, skip and say so. On a service with
  no history every signature is novel and every number unusual.
- Load window stats (from rollups, plus raw error rows for signatures) and
  baseline stats.
- Run the three pure detectors. Collect every trigger that fired.
- If anything fired, persist: extend a recent anomaly if one exists within the
  10-minute merge gap, otherwise create a new one.

## 7. Life of a classification

`pnpm classify` picks up anomalies where `severity IS NULL`, oldest first,
capped at 10 per run.

For each:
1. **Build the evidence packet** — four queries in parallel: window metrics
   (percentiles from rollups, counts from raw logs), signature counts grouped in
   SQL, up to 2000 error/warn rows, up to 2000 info rows.
2. **Render it** — triggers described in words, window totals, the top 8
   signatures with counts and an example, and ~23 log lines sampled by message
   shape.
3. **Call the model** through `generateStructured`: system prompt + packet →
   provider → extract JSON → Zod parse. On failure, re-prompt with the model's
   own output and the specific validation errors, twice at most.
4. **Persist** severity, summary, and `is_real_incident`. If the verdict is
   benign, status becomes `dismissed`.
5. **Record the call** — tokens, latency, repairs, success — to `llm_calls`.

A failure on one anomaly does not stop the run; that row keeps its NULL severity
and is retried next time, which is right for the most likely cause (a free-tier
quota that resets in an hour).

---

## 7a. Life of a correlation

Phase 3, from an incident to a named commit or a considered refusal.

```
  1  loadPending            real incidents with no correlations row
                            (is_real_incident = 1, id NOT IN correlations)
                            — benign windows never reach here

  2  collectCommits         git log --numstat --no-merges --no-renames
                            --since (48h) --until (end of the window)
                            → parseGitLog → Zod → CommitWindow

  3  renderCorrelationContext   the incident and the candidates, two halves:
                                severity, area, summary, detector evidence
                                + raw error text, un-normalised
                                + each commit: sha, age, subject, body, files

  4  generateStructured     CORRELATOR_SYSTEM_PROMPT + packet
                            → extract JSON → correlationSchema → repair ×2

  5  groundCorrelation      the answer vs the candidates it was shown
                            sha not in the list  → FAIL, nothing written
                            10-char sha          → expand to the full 40
                            file not in commit   → drop, report

  6  persistCorrelation     insert the row (null sha included)
                            update anomalies.status = 'correlated'
```

Three steps have no counterpart in Tier 2 and are where the design lives.

**Step 2 is the second data source.** Everything before Phase 3 reads what the
service did. This reads what the developers did, and the conclusion exists in
neither input on its own.

**Step 5 has no Tier 2 equivalent in the pipeline.** `eval/grounding.ts` asks
the same question of `affectedArea`, but only inside the eval. Here it runs on
every call, because a hallucinated sha would be persisted and inherited by Phase
4 as established fact.

**Step 6 runs even when the answer is null.** That row is what keeps "the
correlator considered twelve candidates and declined" distinguishable from "the
correlator never ran" — a distinction no status value carries.

# Part III — Every file

## 8. `packages/shared`

The contract every other package imports. Consumed directly as TypeScript — no
build step between packages.

**`src/schemas/log.ts`** (101 lines) — the wire contract.
`logEntrySchema` accepts an ISO string *or* epoch milliseconds for the timestamp
(with a custom error message, because Zod's default explains nothing to someone
integrating a new service). `logMetadataSchema` types the known fields and
`.catchall(z.unknown())` lets an app attach its own context without a schema
redeploy. Exports `LOG_LEVELS`, `ERROR_LEVELS` (`error`, `fatal`) and
`SIGNATURE_LEVELS` (`warn`, `error`, `fatal`) — deliberately wider, because a
*new kind* of 4xx appearing is a real signal and restricting signatures to error
level would blind the detector to a whole class of regressions. Also
`ingestBatchSchema` (max 1000) and `ingestResultSchema`.

**`src/schemas/anomaly.ts`** (75 lines) — Tier 1 output.
A discriminated union on `kind` for the three trigger types, each carrying its own
evidence: `error_rate_spike` has observed count, baseline mean and standard
deviation, and z-score; `latency_jump` has metric, observed, baseline and ratio;
`new_error_signature` has the signature, a sample raw message, and occurrences.
Plus the `anomalyStatuses` and `severities` enums.

**`src/schemas/agents.ts`** (82 lines) — LLM output contracts.
`classificationSchema` (severity, summary 10–1000 chars, isRealIncident,
affectedArea), `correlationSchema` and `hypothesisSchema` for Phases 3 and 4, and
`llmCallStatsSchema` for the cost record. Also `llmAgents` — the three agent
names — so cost can be attributed per stage.

**`src/schemas/commit.ts`** (93 lines) — source history, Phase 3.
`candidateCommitSchema` (full 40-char sha, `committedAt`, author, subject, body,
files), `changedFileSchema` and `commitWindowSchema`. Line counts are
**nullable** rather than defaulted to zero, because `git log --numstat` prints
`-` for a binary file and "0 lines changed" is a different claim from "the count
does not exist". `commitWindowSchema` carries `since` and `until` alongside the
commits so that "no commit explains this" stays distinguishable from "we never
looked". Subject and body are separate fields — they carry different weight as
evidence and the prompt will render them differently.

**`src/signature.ts`** (52 lines) — normalisation. See [§15](#15-the-algorithms).

**`src/index.ts`** (33 lines) — re-exports everything.

## 9. `packages/generator`

Synthetic traffic. Built *before* the detectors on purpose: it provided data to
develop against from day one and now doubles as the demo driver and the source of
eval cases.

**`src/random.ts`** (49 lines) — a seeded mulberry32 PRNG.
Exposes `next`, `int`, `pick`, `bool`, and `latency(medianMs, tailFactor)`, which
uses Box–Muller to draw a normal sample and exponentiates it into a log-normal —
the shape real latency actually has. Seeding matters: a failing detector test
reproduces exactly, and the demo tells the same story every run.

**`src/scenarios.ts`** (764 lines) — traffic profiles and all nine scenarios.
`BASELINE` is 240 rpm, 0.8% error rate, 45 ms median, tail factor 3. Four weighted
endpoints with their own latency multipliers. A gentle diurnal curve keeps the
baseline from being trivially predictable — which is what makes a mean+stddev
detector worth writing rather than a flat threshold. `BASELINE_ERRORS` are three
failure kinds that exist in normal operation, each building its message
per-occurrence so ids vary (a fixture with hardcoded ids would let a broken
normaliser pass).

`generateMinute(profile, windowStart, rng, scenario?, windowMs?, progress?)` is
the single entry point. The `Scenario` interface carries `benign`, a
`profile(base, progress)` transform, an optional `error` override, and an optional
`context()` that emits narration lines.

| Scenario | Verdict | Shape |
|---|---|---|
| `error-spike` | incident | 35% error rate from baseline failure kinds |
| `latency-jump` | incident | median ×8, tail ×1.6, error rate unchanged |
| `new-error` | incident | 30% errors, all a novel `TypeError` |
| `deploy-restart` | **benign** | 45% errors for the first 20% of the window, then baseline; startup and rollout-complete narration |
| `batch-job` | **benign** | user traffic untouched; 45 slow chunks/min on `/internal/reconcile` plus 409 skip-warnings |
| `rate-limit-storm` | **benign** | 4× volume and 429s from one client id; latency untouched |

**`src/index.ts`** (280 lines) — the CLI: `backfill`, `live`, `inject`.
Sends in chunks of 500, tolerating 207. `generateHistory` ends on a **minute
boundary** — rollup buckets and detection windows are minute-aligned, and
unaligned generation clipped the first generated minute out of the window it was
meant to land in.

## 10. Backend — foundation

**`src/env.ts`** (65 lines) — configuration, validated with Zod at startup.
Uses Node's built-in `process.loadEnvFile`, so no dotenv dependency. Invalid
config exits with a per-field explanation rather than failing mysteriously later.
An unset key in `.env` arrives as `""`, not undefined, so `optionalSecret`
transforms empty strings to undefined — that is what makes `.env.example`
copyable as-is. Exports `llmProviderNames`.

**`src/db/client.ts`** (23 lines) — the Drizzle/better-sqlite3 connection.
Resolves the database path against the repo root (derived from `import.meta.url`,
not `cwd`, so it lands in the same place whether you run from the workspace root
or a package). Sets `journal_mode = WAL` so ingestion keeps writing while
detection reads, and `foreign_keys = ON`.

**`src/db/schema.ts`** (166 lines) — all six tables. See [§4](#4-the-data-model).

**`src/server.ts`** (58 lines) — Fastify app.
`GET /health` returns status, database path and log count. Body limit raised to
16 MB because log batches are large. Logger built conditionally rather than with
`transport: undefined` — under `exactOptionalPropertyTypes` an explicit undefined
is not the same as an absent key. Handles SIGINT/SIGTERM for clean shutdown.

**`src/routes/ingest.ts`** (95 lines) — the one write endpoint.
See [§5](#5-life-of-a-log-line) for the full flow.

## 11. Backend — detection (Tier 1)

**`config.ts`** (80 lines) — every tunable, each with the reasoning for its value.

| Setting | Value | Why |
|---|---|---|
| `baselineMinutes` | 60 | Long enough to absorb minute-to-minute variance, short enough that a regression doesn't get absorbed into its own baseline |
| `minBaselineMinutes` | 30 | Below this, detection is skipped entirely |
| `windowMinutes` | 5 | Smooths single-minute noise, still catches incidents quickly |
| `baselineGapMinutes` | 1 | Stops a slow-building incident raising its own bar |
| `errorRate.stdDevMultiplier` | 3 | ~99.7% of a normal distribution — deliberately conservative |
| `errorRate.minErrorsPerMinute` | 2 | The floor |
| `latency.ratioThreshold` | 3 | |
| `latency.minObservedMs` | 200 | The floor |
| `newSignature.minOccurrences` | 3 | One occurrence is as likely a fluke as a regression |
| `anomalyMergeGapMinutes` | 10 | How recent an anomaly must be to absorb a new firing |

**`stats.ts`** (57 lines) — pure primitives: `mean`, `stdDev`, `percentile`,
`median`. Detailed in [§15](#15-the-algorithms).

**`detectors.ts`** (176 lines) — the three detectors, pure.
Each takes `(WindowStats, BaselineStats, DetectionConfig)` and returns a trigger
or null. `runDetectors` runs all three and returns everything that fired — an
incident commonly sets off more than one and each carries independent evidence.

The floor is checked *first* in each detector: it is the cheapest test and
rejects the noisiest case. `safeZScore` clamps to 999 when baseline variance is
zero, because `JSON.stringify(Infinity)` is `null` and would silently corrupt a
stored trigger.

**`rollup.ts`** (180 lines) — raw logs → aggregates. Two guarantees: idempotent
(every write is an upsert on the unique index) and closed-minutes-only.

**`engine.ts`** (343 lines) — everything the pure detectors deliberately don't do:
loading, orchestration, persistence. Contains no detection logic of its own,
which keeps the provable part provable.

`persistAnomaly` holds the merge rule. Anomalies with status `open` **or**
`dismissed` are mergeable — dismissed included because Tier 2 dismisses benign
patterns and the traffic that produced them usually continues, so without it
every run would create a fresh anomaly and buy another model call for the same
verdict. With one guard:

```ts
const openAnomaly =
  recentAnomaly?.status === "dismissed" &&
  triggers.some((trigger) => !knownKinds.has(trigger.kind))
    ? undefined          // new signal — start fresh, earn a new verdict
    : recentAnomaly;
```

A trigger kind that was not part of what the classifier dismissed is evidence it
has not seen, so it starts a new anomaly rather than inheriting the dismissal.

**`cli.ts`** (191 lines) — `pnpm detect`, with `--rollup-only`, `--detect-only`,
`--watch <sec>`, and `--classify` to chain Tier 2. A one-shot command rather than
a daemon: detection is idempotent and cheap, so running it on an interval from
outside keeps the moving parts obvious.

## 12. Backend — LLM

**`types.ts`** (62 lines) — the provider boundary, and the whole contract:

```ts
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
```

One method. Streaming, tool calling and multi-turn are absent because no agent
here needs them — each asks one question and parses one JSON answer. Token counts
are nullable: not every provider reports usage, and a missing count is not a
reason to fail a call.

**`config.ts`** (64 lines) — temperature 0.1 (repeatable judgements, not
creativity), maxOutputTokens 800, timeout 45 s, 3 HTTP attempts, 2 repair
attempts. Plus default models per provider and the OpenAI-compatible base URLs.
`LLM_MODEL` overrides any default, which is the intended fix when a free-tier
model id gets retired.

**`http.ts`** (105 lines) — one POST helper with the retry policy in one place.
Retries 408/409/425/429 and 5xx plus network failures; honours `Retry-After` up
to 30 s, otherwise 500 ms doubling. Does **not** retry 400/401/403/404 — those
fail identically forever and retrying only delays the message telling you which
of them it is.

**`json.ts`** (67 lines) — `extractJsonObject` scans for a balanced object while
tracking string state and escapes. The naive `indexOf("{")`/`lastIndexOf("}")`
breaks on exactly the input this system processes: an error message containing a
brace. Truncated output returns null, routing it into the repair loop.

**`structured.ts`** (185 lines) — the repair loop, and the one function every
agent calls. Detailed in [§7](#7-life-of-a-classification). Has **no database
import**: cost records go to an injected sink, which is what makes the retry and
validation logic testable with a fake provider and no I/O.

**`calls.ts`** (58 lines) — `recordLlmCall` writes to `llm_calls`;
`llmUsageSummary` aggregates per agent/provider/model.

**`index.ts`** (69 lines) — the factory. A missing key fails at construction with
the variable name to set, rather than as an HTTP 401 halfway through an
unattended run.

**`providers/gemini.ts`** (99 lines) — primary. Uses the native `generateContent`
API rather than Google's OpenAI shim for two things only available there:
`responseMimeType: "application/json"`, and `thinkingConfig: { thinkingBudget: 0 }`.
The second matters — on 2.5 models reasoning tokens bill against
`maxOutputTokens`, so thinking can consume the whole allowance and return an
empty candidate. The error names the finish reason, because the symptom otherwise
looks exactly like a parse bug.

**`providers/openai-compatible.ts`** (103 lines) — NVIDIA NIM, OpenRouter and
Ollama in one implementation; they differ in base URL, auth header and available
models, not wire format. Handles OpenRouter returning upstream errors as HTTP 200
with an `error` field.

**`providers/stub.ts`** (87 lines) — the default. Deterministic, offline, no key.
Scores severity by counting which detectors fired — deliberately the *statistical*
judgement, not a simulation of a semantic one — and says so in its summaries,
because a stub that reads like the real thing will eventually be mistaken for it.
Returns null tokens rather than estimates.

## 13. Backend — classification (Tier 2)

**`context.ts`** (~360 lines) — the evidence builder, pure.
Budget: 8 signatures, 6 endpoints, 20 timeline minutes, 15 error lines, 8 healthy
lines, 240 chars per message. The packet carries four views of the window —
totals (*how much*), a per-minute timeline (*when*), a per-endpoint breakdown
(*where*), and sampled log lines (*what it looks like*). The timeline and
endpoint sections were both added after measurement showed the packet could not
distinguish a burst that stopped from steady failure, nor a slow background path
from a slow service.
`sampleEvenly` spreads across time; `sampleDiverse` groups by message shape and
allocates round-robin rarest-first. Detailed in [§15](#15-the-algorithms).
The `Service:` and `Triggers fired:` lines are load-bearing beyond readability —
the stub parses them.

**`prompt.ts`** (61 lines) — the classifier system prompt, as a constant in its
own file because it is a versionable artefact. Built around what statistics
cannot do, defines each severity band explicitly, and offers `"unknown"` for
`affectedArea` so a model with nothing to say has something true to say.

**`classify.ts`** (417 lines) — orchestration. Loads, builds, calls, persists.
Notable: counts come from the raw log table while percentiles come from rollups.
That is the one place Tier 2 departs from "detection reads aggregates" — the
rollup worker resumes from its last written bucket, so late-arriving logs leave
stale buckets. Tier 1 tolerates that; a prompt cannot, because "67 errors"
printed above a signature table listing 351 occurrences is contradictory
evidence. Scan caps are 2000 for both error and healthy rows.

**`cli.ts`** (157 lines) — `pnpm classify`, with `--limit`, `--anomaly`,
`--provider`, `--preview` (prints the exact prompt, calls nothing) and `--stats`
(the funnel and per-provider usage).

## 14. Backend — eval

**`cases.ts`** (70 lines) — golden case schema, loading and saving. The `context`
field is the **entire rendered prompt as a string**. Storing a structured input
and re-rendering would let fixtures change silently with the renderer; a stored
string is a fixed artefact, so scores are comparable across prompt versions. Cases
are validated on load — a malformed case would otherwise score as a silent wrong
answer against the model.

**`grounding.ts`** (79 lines) — is `affectedArea` supported by the evidence?
Declining (`unknown`) counts as grounded. If the area names a path, every path
must appear verbatim in the context. Otherwise ≥60% of its words of 4+ characters
must appear. Deliberately mechanical — an LLM judge would be a model grading a
model.

**`score.ts`** (124 lines) — severity bands, per-case scoring, and a summary that
reports verdict accuracy **separately** for benign and incident cases. A model
answering "critical incident" to everything scores 100% on the incident half, and
a blended number hides that completely.

**`run.ts`** (86 lines) — runs the set through a provider using the real
`generateStructured`. Passes no sink, so eval calls never pollute `llm_calls`.

**`cli.ts`** (219 lines) — `pnpm eval`, with `--provider`, `--case`, `--list`,
`--show`, and `--capture`. Exits non-zero when any verdict is wrong.

**`verdicts.ts`** (116 lines) — pinned Tier 2 verdicts, one JSON fixture per
scenario. A correlation packet embeds the classifier's judgement, and
re-deriving it from a model at capture time made the set's difficulty drift
between generations. An eval measures one stage with its input held fixed; this
restores that property for Tier 3, the way a stored context already does for
Tier 2. Loading throws rather than falling back to a live classification, since
a silent fallback would reintroduce the variance invisibly.

Side effect worth having: capture now makes **no model calls at all**, and no
longer requires Tier 2 to have run first.

**`correlation-cases.ts`** (123 lines) — the Phase 3 case schema. Same
stored-string design as `cases.ts`, with one property the classifier set lacks:
a correlation case is **self-contained**. Its prompt names its candidates and
its label names one of them, so scoring needs no repository at all — which
matters because the fixture is generated and its shas depend on an anchor date.

**`score-correlation.ts`** (197 lines) — the four axes, pure. Attribution and
declining are **never averaged**: a model that always names something scores
100% and 0%, one that always declines scores the reverse, and blended both read
as a respectable half. Files are scored only on correctly attributed cases with
a non-empty label, as a subset rather than an exact match. Confidence is
reported as mean-when-right against mean-when-wrong, deliberately coarse.

**`run-correlation.ts`** (96 lines) — the cases through a provider. One
deliberate difference from the pipeline: `groundCorrelation` is **not** applied,
because an invented sha is exactly the mistake worth measuring. Grounding first
would score a hallucination as "the provider errored".

**`cases/*.json`** — six captured cases, three incidents and three benign.

**`correlation-cases/*.json`** — six captured cases: two attributable to
*different* commits, four where the answer is `null` and six candidates are
offered anyway. Two different commits is load-bearing — with one, "finds the
guilty commit" and "has learned the answer" score identically. So is four
declines for four different reasons: `llama3.2` names one commit to every case,
which read as 2/2 attribution on a two-decline set and reads as 0/4 declining
here.

**`scripts/capture-correlation-cases.sh`** (repo root, 146 lines) — rebuilds the
correlation set. Differs from the classifier capture in three ways: it runs Tier
2 first (correlation only sees confirmed incidents, so a stub summary would make
an unrealistic artefact), it rebuilds the fixture with `--anchor now` so the
history overlaps freshly generated traffic, and its `--sha` labels are resolved
against the candidates in the packet being captured — capture fails if the
expected commit is not in its own evidence.

**`scripts/capture-cases.sh`** (repo root) — rebuilds the whole golden set from
real pipeline runs against scratch databases under `.tmp/`. Required whenever the
evidence packet changes, since a stored case is a fixed artefact of the renderer
that produced it.

## 14a. Backend — correlation (Phase 3, partial)

The first stage that reads a second data source. Everything before it looks at
what the service did; this puts that next to source history. Complete and
measured as of Phase 3 — across three models, 2/2 attribution everywhere and
1/2 declining on both Gemini variants, against a baseline that scores zero on
both. See `DOCUMENTATION-PHASE-3.md` §11.

**`commits.ts`** (214 lines) — the `git log` parser, **pure**. Exports
`GIT_LOG_FORMAT`, `GIT_LOG_ARGS` and `parseGitLog`. Text in, commits out: no
subprocess, no clock, no database, so its tests need no repository at all.

The format is framed on two ASCII control characters rather than readable
punctuation, because a commit body contains whatever a developer typed and a
parser keyed on punctuation mis-attributes causes rather than crashing. `\x1e`
brackets each header, `\x1f` separates fields, and the body is the last field —
split off by *position*, so a body containing `\x1f` parses correctly. A `\x1e`
inside a body is not closable in this format and is **detected** instead, by two
guards that leave no quiet path through. A malformed record throws rather than
being skipped: a correlation over a history with a hole in it looks exactly as
confident as a correct one. Detailed in `PHASE-3` §5.

**`git.ts`** (145 lines) — the impure half. `resolveTargetRepo` resolves
`TARGET_REPO_PATH` (relative paths from the repo root, not cwd) and verifies it
is really a repository, with an error naming the script that builds the fixture.
`collectCommits` spawns `git log` via `execFile` — an argument array, never a
shell — and validates the result.

`defaultLookback` is 48 hours and 25 commits, whichever binds first. Both are
**arguments, not measurements**; the header says so, because four correlation
cases cannot tune them. `--until` is the end of the anomaly window, so a commit that
postdates its supposed effect is never fetched and never offered.

**`context.ts`** (~380 lines) — the correlation evidence packet, **pure**. It
can render unified diffs (`{ diffs: true }`) and does not by default: a
controlled A/B cost one regression, showed no reproducible benefit, and grew the
packet 3.7×. See §19 and `DOCUMENTATION-EVALS.md` §14. Two
halves with a seam: the incident (severity, affected area, the classifier's
summary, the detector evidence) and the candidates (sha, timestamp, age relative
to the window, author, subject, body, files).

Budget: 25 commits, 12 files each, 400 chars of body, 300 of raw error text.
The body budget is generous relative to Tier 2's 240-char log lines because it
is load-bearing — the two most confusable fixture commits touch the same two
files, and only their bodies separate them.

One subtlety worth knowing: `describeTrigger` prints the **normalised**
signature, which is what the detector compared against the baseline — and
normalisation removes the token that points at code. `reading '<str>'` matches
nothing in a repository; `reading 'toFixed'` matches a file about formatting
money. So the packet prints the raw sample alongside the collapsed shape. The
first draft omitted it and a test caught it.

Short shas are rendered rather than full ones (fewer characters to mistype;
`correlationSchema` accepts 7–40). Commits are rendered newest first — the order
git prints them, and deliberately not reordered to discourage a recency
heuristic, because arranging evidence to influence an answer is a worse failure
than the one it would prevent. "No candidates" is stated explicitly, since an
absent section reads as *not provided* and only "searched, found nothing" makes
`null` correct.

**`prompt.ts`** (137 lines) — the correlator system prompt, a constant in its
own file for the same reason the classifier's is: a versionable artefact `git
log` can answer questions about. ~915 tokens.

Built around three failure modes a capable model walks into unprompted, each of
which the fixture is built to expose — recency, filename matching, and answering
from the list rather than declining. The care went into not overshooting the
first: recency *is* evidence, and the instruction is "timing narrows the field;
it does not decide it" rather than "ignore timing", because a prompt that
disregarded recency would be wrong more often on real incidents where the guilty
commit genuinely is recent.

Requires a stated mechanism, which is what makes a wrong answer *detectably*
wrong — the property `eval/grounding.ts` gives `affectedArea` in Tier 2.
Confidence bands are spelled out for the same reason severity bands are.

**`commits.test.ts`** (195 lines) — 15 cases, every one a plain string. Covers a
body containing the unit separator, a multi-paragraph body, a binary file, a
path containing a tab, an empty commit, an empty body, and four failure modes.

**`grounding.ts`** (130 lines) — the answer checked against the evidence,
**pure**. `correlationSchema` guarantees the answer is well-formed; it cannot
guarantee it is true to the evidence, because it has never seen the evidence.

Two failure kinds, treated differently. An **invented sha is fatal** — the sha
is the causal claim, and coercing it to null would record a hallucination as a
considered "no commit explains this", corrupting the one measurement the
nullable field exists to make possible. An **invented file is dropped and
reported** — the sha still points at a real diff, so the answer stays checkable.

Prefixes resolve against the candidate list rather than by asking git, so
resolution cannot succeed for a commit the model was never shown: the lookup and
the grounding check are the same operation. An ambiguous prefix is ungrounded
rather than resolved to the first match.

**`correlate.ts`** (372 lines) — orchestration. "Uncorrelated" is the absence of
a `correlations` row, not a status value, for the same reason Tier 2 keys off
`severity IS NULL`. Only real incidents are loaded — benign windows were already
dismissed, and correlating a rolling restart is the wasted call the design
exists to avoid.

A null sha still writes a row: "no commit explains this" is a finding that cost
a model call, and recording it keeps "declined" distinguishable from "never
ran". Status moves `open → correlated` either way — it records that the stage
ran, not that it blamed something.

**`cli.ts`** (239 lines) — `pnpm correlate`, with `--limit`, `--anomaly`,
`--provider`, `--preview` (boolean; `--anomaly` picks the target), `--lookback`,
`--repo` and `--stats`. Prints the candidate count on every line, because
declining from twelve candidates and declining from zero read identically
without it, and surfaces dropped files rather than hiding them.

**`context.test.ts`** (196 lines) — 13 cases. Checks that the raw error text
survives, that "no candidates" is explicit, and that every budget cap prints
what it elided rather than silently dropping it.

**`prompt.test.ts`** (92 lines) — guards prompt discipline, not wording. The
easiest way to raise a correlation score is to put an example in the prompt, and
it invalidates every number produced afterwards. `CLAUDE.md` states that rule; a
rule living only in a document survives as long as the next person who has not
read it, so this fails CI instead. Checks that no fixture identifier appears, no
sha appears, and no worked example is offered. Verified by inserting a leak
deliberately and watching three guards fire.

**`grounding.test.ts`** (162 lines) — 11 cases, hallucinations included. The
asymmetry between the two failure kinds is the thing under test.

**`scripts/build-fixture-repo.sh`** (repo root, 503 lines) — builds
`fixtures/orders-api`, the repository correlation runs against: 12 real commits
over nine days, containing the null-price bug the `new-error` scenario emits.
Generated rather than committed, with every date and identity pinned so the shas
are byte-identical on every run. **Gitignored** — a fresh clone must build it.

The history is built to defeat three cheap heuristics: the bug is not the newest
commit, three separate commits touch `pricing.js`, and the rate-limiter commit
is a tempting wrong answer for a scenario whose correct answer is `null`. Same
discipline as the benign scenarios in Tier 2 — a test with only one available
answer measures nothing. Detailed in `PHASE-3` §3.

---

# Part IV — Reference

## 15. The algorithms

**Signature normalisation** (`shared/src/signature.ts`) — seven ordered
replacements, then whitespace collapse and a 512-char cap:

1. UUIDs → `<uuid>` (before the number rule, or their digits get eaten first)
2. ISO-8601 timestamps → `<timestamp>`
3. `0x…` hex → `<hex>`
4. Hex blobs of 12+ chars → `<hex>`
5. Single- and double-quoted values → `<str>`
6. Paths of 2+ segments → `<path>`
7. Any remaining number → `<num>`

Rule 7 has a **deliberately absent trailing `\b`**: `ms` in `after 3000ms` is a
word character, so requiring a boundary would leave the digits and make `3000ms`
and `5000ms` distinct signatures — the exact false novelty this exists to
prevent. The leading `\b` still protects digits inside identifiers like `utf8`.

Measured effect: 87 distinct raw `Rate limit exceeded for client N` messages
collapse to one signature. Without it, the new-signature detector would flag
~170 "novel" errors per minute of perfectly healthy traffic.

**Statistics** (`detection/stats.ts`):
- `stdDev` uses Bessel's correction (n−1). The baseline is a *sample* of the
  service's behaviour, not the population of every minute it will ever run; the
  population formula understates spread and fires too readily.
- `percentile` interpolates linearly rather than picking nearest rank. At 20
  samples, nearest-rank p95 can only land on one of two observations, making the
  metric jumpy minute to minute.
- `median` is used for the **latency baseline specifically**, while the error
  baseline uses the mean. A latency spike already sitting in the baseline would
  drag a mean upward and raise the bar exactly when a service has recently
  misbehaved.

**Diverse sampling** (`classification/context.ts`) — the rule is *a log line is
informative roughly in proportion to how rare its shape is*. Lines are grouped by
`endpoint + statusCode + normalizeErrorSignature(message)`, groups sorted
rarest-first, then the budget is handed out one slot at a time cycling through
groups — so every shape gets its first slot before any gets a second. Remaining
slots fall through to common shapes, so the budget is always spent. Finally
`sampleEvenly` runs *within* each group, so a shape's own progression still
shows.

This exists because uniform sampling dropped a deploy banner — one line among two
thousand — leaving a benign window that no reader could have judged correctly.

## 16. Configuration

Environment (`.env`, all optional — defaults work):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 4000 | Ingestion API |
| `DATABASE_URL` | `file:./data/dev.db` | `file:` prefix stripped by the client |
| `LLM_PROVIDER` | `stub` | `gemini \| nvidia \| openrouter \| ollama \| stub` |
| `LLM_MODEL` | per provider | Overrides the default model |
| `LLM_TEMPERATURE` | 0.1 | Sampling override, for measuring eval repeatability |

The generator takes `--seed` (default 42) and `--end-at <iso>`. Together they
make a run byte-for-byte reproducible, which is what makes a correlation
re-capture reproduce its predecessor.
| `GEMINI_API_KEY` | — | Free tier, no card |
| `NVIDIA_API_KEY` | — | Free developer tier |
| `OPENROUTER_API_KEY` | — | Free `:free` variants |
| `OLLAMA_BASE_URL` | `localhost:11434` | Local, no key |
| `INGEST_URL` | `localhost:4000/ingest` | Generator target |
| `TARGET_REPO_PATH` | `./fixtures/orders-api` | The repository Phase 3 correlates against. Relative paths resolve from the repo root, not cwd |
| `GITHUB_TOKEN`, `GITHUB_REPO` | — | Phase 3, unused — correlation reads a local checkout, not the API |

Code-level tunables live in `detection/config.ts` (thresholds),
`llm/config.ts` (temperature, retries, models), `classification/context.ts`
(`contextBudget`), `correlation/context.ts` (`correlationBudget`) and
`correlation/git.ts` (`defaultLookback`).

## 17. Commands

```bash
pnpm install && pnpm db:push        # setup
pnpm backend                        # ingestion API on :4000
pnpm typecheck                      # strict TS, all packages
pnpm test                           # 162 unit tests, ~300ms, no network

pnpm generate backfill --minutes 120
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm generate live
pnpm generate --help                # lists all nine scenarios

pnpm detect                         # rollup + detect once
pnpm detect --watch 30              # every 30s
pnpm detect --classify              # chain Tier 2

pnpm classify                       # classify unclassified anomalies
pnpm classify --preview <id>        # the exact prompt, no call
pnpm classify --stats               # funnel + cost

pnpm eval                           # score the golden set
pnpm eval --provider stub           # statistical baseline
pnpm correlate                      # Phase 3 — which commit, or none
pnpm correlate --preview            # the exact prompt, no call
pnpm correlate --provider stub      # the naive "blame the newest" baseline
pnpm correlate --stats              # the correlation funnel

pnpm eval --show <name>             # a case's evidence packet
pnpm eval --correlation             # score the correlation set
pnpm eval --correlation --list      # the correlation set and its labels

bash scripts/build-fixture-repo.sh  # the repo Phase 3 correlates against
bash scripts/build-fixture-repo.sh --anchor now   # for a live demo; different shas
```

## 18. Testing strategy

Eleven test files, 162 tests, ~300 ms, no network or database.

| File | Covers |
|---|---|
| `detection/stats.test.ts` | The four statistics primitives |
| `detection/detectors.test.ts` | All three detectors, thresholds, floors |
| `classification/context.test.ts` | Budget caps, shape sampling, narration survival, timeline, endpoint breakdown |
| `llm/structured.test.ts` | JSON extraction, repair loop, cost accounting, stub |
| `eval/score.test.ts` | Grounding, severity bands, split summary |
| `correlation/commits.test.ts` | `git log` parsing: separators in bodies, binary files, tabs in paths, four failure modes |
| `correlation/context.test.ts` | Correlation packet: raw error text, explicit "no candidates", budget elisions, age formatting |
| `correlation/prompt.test.ts` | Prompt discipline: no fixture identifiers, no shas, no worked examples |
| `correlation/grounding.test.ts` | Sha resolution, invented shas rejected, invented files dropped |
| `eval/score-correlation.test.ts` | The four axes: attribution and declining never averaged, files scored only where applicable |
| `eval/verdicts.test.ts` | Pinned verdicts parse, cover every case's scenario, and match what the stored packets contain |

Two conventions worth knowing. Tests run against the **real config objects**, not
fixtures, so changing a threshold fails a test rather than silently altering
sensitivity. And the pure/impure split means none of this needs a database to
seed, a clock to freeze, or an async call to await.

The golden set is a **benchmark, not a test** — it needs a provider and it scores
rather than asserts, so it is not part of `pnpm test`.

## 19. Known limitations

Consolidated from every phase; previously scattered across four documents.

**Silence is not detected.** The detection window anchors to the latest bucket
containing data, so a service that stops logging entirely freezes detection
instead of raising an alarm. A dead service is arguably the most severe incident
there is, and Tier 1 cannot see it.

**Model capability is load-bearing, and the floor is high.** On
`gemini-3.5-flash` the golden set scores 6/6 on every measure, stably. On
`gemini-2.5-flash` it dismisses 1 of 3 benign windows, and on a 3B local model 0
of 3 — the same as the statistical baseline, meaning the tier adds nothing at
that size. The design assumes a capable model and degrades to useless without
one. See `DOCUMENTATION-EVALS.md` §10.

**Rollup staleness.** The worker resumes from its last written bucket, so logs
arriving for an already-aggregated minute leave that bucket stale. Detection
tolerates it; classification works around it by counting from raw logs.

**Row-scan bias.** Above 2000 rows of either kind in a window, the scan takes the
earliest rows, biasing the log sample toward the start.

**In-memory rollup.** The worker reads a window into memory to compute
percentiles. Fine at tens of thousands of rows; beyond that, counts would move
into SQL and only latencies would stream.

**Single service.** Everything is per-service; no cross-service cascade
detection, and the evidence packet describes one service.

**Merge-window collision.** A genuinely new incident inside the merge gap
presenting the same trigger kinds folds into the existing anomaly.

**Six eval cases, one application shape.** Enough to catch a model that defaults
to one answer; not enough to rank two competent models, and the benign cases are
the *easy* kind — each announces itself in text. Harder ones (a traffic shift, a
dependency degrading within SLA) have no narration to read.

**Golden cases are captured artefacts.** They store the rendered prompt, so any
change to the evidence packet invalidates them and `scripts/capture-cases.sh` has
to be re-run. That is the deliberate cost of measuring the prompt the system
actually sends.

**Free-tier quota bounds the eval.** 20 requests a day *per model*, so a
six-case run plus any experimentation exhausts one model's budget. The eval is a
once- or twice-daily instrument, not something to run in a loop — which is also
why `pnpm classify` caps a run at 10 anomalies. Quota is bucketed per model, so
`LLM_MODEL` is the way through a 429 when one model is spent.

**No cost in currency.** `llm_calls` records tokens, not dollars, because every
provider in use is free and a cost column reading `0.00` would imply precision
that isn't there.

**Scores are reproducible, and captures are deterministic.** Re-running stored
cases gives zero decision variance over 17 answers (only confidence moves,
±0.05). Re-capturing used to flip decisions; the generator's timestamps were
wall-clock, so runs landed on different minute boundaries and aggregated ~2%
apart. `--end-at` pins them, and two independent captures now produce
byte-identical packets — verified. After a re-capture, `git diff` should touch
only `capturedAt`.

**The packet cannot exonerate an innocent commit.** With no diff content,
`src/routes/orders.js +2/-1` could be a string format or a synchronous network
call. Hunks were built to fix this and measured; the A/B did not support
adopting them, so they are off by default. `DOCUMENTATION-EVALS.md` §14.

**Correlation cases used to inherit the classifier's variance**, so a re-capture
could silently swap a hard case for an easy one — one failed on three models in
one generation and passed on two in the next with no packet change. Fixed by
pinning Tier 2's verdict as a fixture (§14a). What still varies per capture is
the generated traffic and the fixture shas, so cross-generation comparisons
remain a judgement rather than an automatic one.

**Four correlation cases, and only two of them decline.** The decline half is
the part that distinguishes the tier from its baseline, and it is the thinnest
part of the set — the same weakness the classifier set has, one tier along.

**The fixture history is authored by us**, so a critic can fairly say the
correlation task was made findable. The decoys and the two `null` cases are what
answer that; the positive case alone would not.

**Commit time is not deploy time.** Correlation matches against when a commit
was authored, not when it shipped. In any real pipeline those differ, sometimes
by days.

**No diff content, and renames are lost.** The collector carries subjects,
bodies and per-file line counts — not hunks — so a bug visible only in the diff
is invisible to the agent. `--no-renames` means a moved file looks like a delete
and an add.

## 20. What is not built

| Phase | Scope | State |
|---|---|---|
| 3 | Commit correlation | ✅ **Done and measured** on a six-case set — 2/2 attribution and 4/4 declining on `gemini-2.5-flash`, against a 0/2 and 0/4 baseline. Single runs are samples; see §19 |
| 4 | Root-cause + fix agent, human-gated | Schema and contract exist; no code |
| 5 | Next.js dashboard with reasoning trace | Not started |

Phase 3's blocking decision is settled: correlation runs against a real git
repository built by `scripts/build-fixture-repo.sh` and gitignored, rather than
an external repo or a JSON fixture. `DOCUMENTATION-PHASE-3.md` §2 gives the
reasoning and what it costs.

Note the change of approach from the original plan: correlation reads a **local
checkout**, not the GitHub API. `GITHUB_TOKEN` and `GITHUB_REPO` are vestigial.

Phase 3 is complete as code and its harness is reproducible end to end: stable
across repeats, and deterministic across captures. What that unblocks is
everything that needed a stable baseline — re-running the hunks A/B against a
later capture, and comparing models on different days without re-capture being a
confound.

One decision precedes the golden cases — whether `deploy-restart`'s fabricated
deploy sha becomes a real one. It would make the strongest `null` test in the
set, and it invalidates all six existing cases.
`DOCUMENTATION-PHASE-3.md` §13.
