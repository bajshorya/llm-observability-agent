# LLM-Powered Observability Agent

Detects runtime anomalies in a monitored application, correlates them with recent
commits, and produces a plain-English root-cause hypothesis plus a suggested fix —
with the agent's full reasoning trace visible end to end.

The point is the *system*, not the model call: cheap statistics catch the obvious
cases for free, and the LLM is only invoked where semantic understanding actually
earns its cost.

> Architecture and full build plan: [`observability-agent-architecture.md`](./observability-agent-architecture.md)

---

## Status

| Phase | Scope | State |
|---|---|---|
| **0** | Scaffold, schema, log generator, ingestion | ✅ Done |
| **1** | Rollup worker + Tier 1 statistical detectors (no LLM) | ✅ Done |
| 2 | Tier 2 LLM classifier + cost logging | Next |
| 3 | GitHub commit correlation agent | |
| 4 | Root-cause + fix agent (human-gated) | |
| 5 | Next.js dashboard with reasoning trace | |

---

## Quick start

```bash
pnpm install
cp .env.example .env          # defaults work as-is for local development
pnpm db:push                  # create data/dev.db from the Drizzle schema

pnpm backend                  # terminal 1 — ingestion API on :4000
pnpm generate backfill --minutes 180   # terminal 2 — seed a baseline
```

Check it worked:

```bash
curl -s localhost:4000/health
```

### Generating traffic

The synthetic generator exists **before** the detectors on purpose: it gives us
realistic data to develop against from day one, and later doubles as the demo
driver.

```bash
pnpm generate backfill --minutes 180        # healthy history, generated instantly
pnpm generate live                          # continuous healthy traffic
pnpm generate inject --scenario new-error   # trigger an anomaly
pnpm generate --help
```

Backfill matters more than it looks. Detection compares a window against a
*trailing baseline*, so without it you would have to sit and wait an hour in real
time before any detector could say anything.

| Scenario | What it simulates |
|---|---|
| `error-spike` | Error rate jumps ~40x using errors already present in the baseline |
| `latency-jump` | Tail latency degrades sharply with no change in error rate |
| `new-error` | A never-before-seen signature appears — the null-price bug |

---

## Detection (Tier 1)

Statistics only. No LLM, no API key, no cost.

```bash
pnpm detect                 # roll up, then run the detectors once
pnpm detect --watch 30      # repeat every 30s
pnpm detect --rollup-only   # just recompute aggregates
pnpm test                   # 27 unit tests over the detectors and stats
```

A firing window looks like this:

```
Rollup: 18363 logs -> 480 buckets (06:28 to 08:28)
Window 08:23 to 08:28 (baseline 60 min):
  orders-api: ANOMALY created  6a185278
    - error_rate_spike     211 errors in window; baseline 0.33/min ±0.6, z=69.62
    - new_error_signature  "TypeError: Cannot read properties of null (reading <str>)" x210
                       sample: TypeError: Cannot read properties of null (reading 'toFixed')
```

Three detectors, each with a **relative** threshold and an **absolute floor**:

| Detector | Fires when | Floor stops |
|---|---|---|
| `error_rate_spike` | errors/min > `mean + 3σ` of baseline | One extra error on a quiet service |
| `latency_jump` | window p95 ≥ 3x baseline p95 | 2ms → 8ms being called a 4x regression |
| `new_error_signature` | signature absent from baseline, ≥3 occurrences | A single fluke |

The relative test makes it adaptive; the floor stops it firing on changes that are
statistically dramatic but practically meaningless.

Verified behaviour: a healthy baseline produces **zero** anomalies, `error-spike`
fires only the error-rate detector, `latency-jump` fires only the latency
detector, and `new-error` fires both the signature and error-rate detectors —
correctly, since that scenario genuinely creates both conditions.

Generation is seeded (`--seed`), so a failing detector test reproduces exactly and
the demo tells the same story every run.

---

## Layout

```
packages/
  shared/      Zod schemas + error-signature normalisation. The contract
               every other package imports.
  backend/     Fastify ingestion API, Drizzle schema, SQLite client,
               and the Tier 1 detection pipeline (src/detection).
  generator/   Synthetic traffic with on-command anomaly injection.
```

Inside `backend/src/detection`, the split that matters is **pure vs impure**:
`detectors.ts` and `stats.ts` are pure functions with no database, clock, or I/O,
which is what makes them provable with fixed inputs. `rollup.ts` and `engine.ts`
own everything that touches the database.

`@obs/shared` is consumed directly as TypeScript — no build step between packages.

---

## Design notes

**Ingestion is deliberately dumb.** `POST /ingest` validates and persists, nothing
else. It sits in the hot path of every monitored service, so the only things it is
allowed to be are correct and fast.

**Partial success.** One malformed entry in a batch of 500 does not cost you the
other 499. The response reports `accepted`, `rejected`, and the per-index reason
for each rejection, with HTTP 207 when a batch is partially accepted.

**Error signatures are normalised at ingest.** Variable detail (ids, timestamps,
durations, quoted values) is stripped so that recurring failures collapse onto a
stable key. In the seeded baseline, 87 distinct raw `Rate limit exceeded for
client N` messages collapse into a single signature. Without this, the
new-signature detector would flag ~170 "novel" errors per minute of perfectly
healthy traffic.

Computing it at write time is a small, deliberate exception to "keep ingestion
dumb": it is a pure O(1) string transform, and it turns the new-signature detector
into an indexed lookup instead of a regex pass over millions of rows at query
time.

**SQLite now, Postgres later.** Timestamps are stored as epoch milliseconds and
JSON as text — SQLite's equivalents of `timestamptz` and `jsonb`. The migration is
a swap of the column builders in `packages/backend/src/db/schema.ts` and the driver
in `client.ts`. No query or application code changes.

**LLM providers are pluggable, and all free.** Phase 2 sits behind a single
interface with Gemini (primary), NVIDIA NIM (backup), OpenRouter (model comparison
for the eval harness), Ollama (offline dev loop), and a deterministic stub for
tests. No API key is needed until Phase 2, and the project runs at $0.

---

## Data model

| Table | Purpose |
|---|---|
| `logs` | Raw entries. Indexed on `(service, timestamp)` — every detection query is time-windowed. |
| `metrics_rollup` | Per-minute aggregates so detection reads cheap summaries, not millions of rows. |
| `anomalies` | Tier 1 output (window + triggers), enriched by Tier 2 (severity, summary). |
| `correlations` | Suspected commit, confidence, reasoning. |
| `hypotheses` | Root cause and suggested fix. `applied` stays `false` — human gate. |
| `llm_calls` | Tokens and latency per call. This is what substantiates the two-tier cost claim. |

---

## Useful commands

```bash
pnpm typecheck            # strict TS across all packages
pnpm db:studio            # browse the database
sqlite3 data/dev.db "SELECT error_signature, COUNT(*) FROM logs \
  WHERE error_signature IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;"
```

Reset to a clean slate:

```bash
lsof -ti:4000 | xargs kill -9
rm -f data/dev.db*
pnpm db:push
```
