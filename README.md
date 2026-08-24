# LLM-Powered Observability Agent

Detects runtime anomalies in a monitored application, correlates them with recent
commits, and produces a plain-English root-cause hypothesis plus a suggested fix —
with the agent's full reasoning trace visible end to end.

The point is the *system*, not the model call: cheap statistics catch the obvious
cases for free, and the LLM is only invoked where semantic understanding actually
earns its cost.

**New here? Read [`START-HERE.md`](./START-HERE.md) — 5 minutes, and it makes
everything below optional.**

The documents in the table are *reference*: written to be searched when you have
a specific question, not read front to back. There are ~30,000 words of them.
`START-HERE.md` tells you which section answers which question.

| Document | Covers |
|---|---|
| [`START-HERE.md`](./START-HERE.md) | **The 15-minute orientation. Start here.** |
| [`CODEBASE.md`](./CODEBASE.md) | **The complete reference — architecture, design, every file, current state.** |
| [`observability-agent-architecture.md`](./observability-agent-architecture.md) | The original architecture and full build plan |
| [`DOCUMENTATION.md`](./DOCUMENTATION.md) | Phase 0 — scaffold, schemas, storage, ingestion, generator |
| [`DOCUMENTATION-PHASE-1.md`](./DOCUMENTATION-PHASE-1.md) | Phase 1 — rollup worker and the three Tier 1 detectors |
| [`DOCUMENTATION-PHASE-2.md`](./DOCUMENTATION-PHASE-2.md) | Phase 2 — provider layer, structured output, LLM classifier |
| [`DOCUMENTATION-EVALS.md`](./DOCUMENTATION-EVALS.md) | Benign scenarios, evidence-sampling fixes, and the golden-set harness |

Each reference document goes file by file: what the code does, how it works, and
why it was written that way. They are phase-ordered, so where two disagree, the
later one wins — `START-HERE.md` lists the known cases.

---

## Status

| Phase | Scope | State |
|---|---|---|
| **0** | Scaffold, schema, log generator, ingestion | ✅ Done |
| **1** | Rollup worker + Tier 1 statistical detectors (no LLM) | ✅ Done |
| **2** | Tier 2 LLM classifier, provider layer, cost logging | ✅ Done |
| 3 | Commit correlation agent | 🚧 Runs end to end; no eval yet |
| 4 | Root-cause + fix agent (human-gated) | |
| 5 | Next.js dashboard with reasoning trace | |

`pnpm correlate` runs end to end. In one observed run `gemini-3.5-flash` named
the right commit with a stated mechanism while the naive baseline named the
wrong one — but that is **n=1 on the positive half**. There is no correlation
eval, nothing tests the `null` path, and so no accuracy figure exists.
`DOCUMENTATION-PHASE-3.md` §11–12 is the honest inventory.

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

| Scenario | What it simulates | Correct verdict |
|---|---|---|
| `error-spike` | Error rate jumps ~40x using errors already present in the baseline | incident |
| `latency-jump` | Tail latency degrades sharply with no change in error rate | incident |
| `new-error` | A never-before-seen signature appears — the null-price bug | incident |
| `deploy-restart` | Connection-refused burst during a rolling restart, then recovery | **dismiss** |
| `batch-job` | Reconciliation drags aggregate p95; user endpoints stay healthy | **dismiss** |
| `rate-limit-storm` | One client floods the API and is throttled; nothing else degrades | **dismiss** |

The bottom three all trip Tier 1 on purpose. `deploy-restart` is statistically
indistinguishable from `new-error` — same two detectors, comparable magnitudes.
Everything separating them is text, which is the entire case for Tier 2 and what
`pnpm eval` measures it on.

---

## Detection (Tier 1)

Statistics only. No LLM, no API key, no cost.

```bash
pnpm detect                 # roll up, then run the detectors once
pnpm detect --watch 30      # repeat every 30s
pnpm detect --rollup-only   # just recompute aggregates
pnpm test                   # 129 unit tests; 27 of them over the detectors and stats
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

## Classification (Tier 2)

The LLM stage. It runs only on windows Tier 1 already flagged, and answers the
question statistics cannot: *is this actually an incident, and how bad?*

```bash
pnpm classify                    # classify anything unclassified (default: stub, free, offline)
pnpm classify --preview <id>     # print the exact prompt for an anomaly, call nothing
pnpm classify --stats            # the funnel and what it cost
pnpm detect --classify           # chain both tiers in one run
```

```
$ pnpm detect --classify
  orders-api: ANOMALY created  5cb16f57
    - error_rate_spike     67 errors in window; baseline 0.57/min ±0.77, z=16.73
    - new_error_signature  "TypeError: Cannot read properties of null (reading <str>)" x351
Tier 2 via ollama (llama3.2):
  5cb16f57: CRITICAL (incident) — Multiple TypeErrors on the checkout path…
    1342 in / 56 out tokens, 0 repair(s)
```

A deploy restart, a batch job and an outage produce the same statistical shape.
They do not produce the same log text — so this tier reads, and a window it
judges benign is **dismissed** rather than passed to correlation.

**Every model output is parsed into a Zod schema.** Nothing downstream consumes
free-form text. When validation fails, the model is re-prompted with its own
output and the specific errors, twice at most — a model that cannot produce the
shape twice will not produce it on the fifth try, and each retry costs tokens.

**The context is budgeted, not dumped.** A five-minute window is tens of
thousands of lines; the model gets ~23 of them, plus per-minute totals, a
per-endpoint latency breakdown, per-signature counts and
window aggregates. They are sampled by *message shape*, not uniformly, because a
line is informative in proportion to how rare its shape is: twenty copies of
`GET /orders 200` say what one copy says, while a single `v1.4.2 starting up`
explains the whole window. Uniform sampling dropped exactly that line, which is
how the rule was found. The builder is pure, so the same window always produces
the same prompt.

**Every call is costed.** `llm_calls` records tokens, latency, repair attempts
and success per invocation — failures included, since those spend quota too.
`pnpm classify --stats` is what substantiates the two-tier claim.

### Providers

| Provider | Role | Key needed |
|---|---|---|
| `stub` | **Default.** Deterministic, offline, no account | No |
| `gemini` | Primary. Native JSON mode, thinking disabled | Free, no card |
| `nvidia` | Backup | Free tier |
| `openrouter` | Model comparison for evals | Free `:free` variants |
| `ollama` | Offline dev loop | No — runs locally |

All five sit behind one `complete()` method, and the last three share a single
OpenAI-compatible implementation. Everything works with no key at all: the stub
runs the full pipeline and the tests need no network.

---

## Correlation (Phase 3)

The stage that reads a second source. Everything before it looks at what the
service did; this puts that next to the source repository's history and asks
which commit explains it — **or whether none does**.

```bash
pnpm correlate                   # correlate real incidents (default: stub, free, offline)
pnpm correlate --preview         # print the exact prompt, call nothing
pnpm correlate --provider stub   # the naive "blame the newest commit" baseline
pnpm correlate --lookback 168    # widen the commit window for one run
pnpm correlate --repo <path>     # a different checkout, without editing .env
pnpm correlate --stats           # the correlation funnel
```

```
$ pnpm correlate
Provider: gemini (gemini-3.5-flash)
  99335b7a orders-api [6 candidate(s)]: 915c23dfe8 (confidence 0.90)
    Commit 915c23dfe8 introduced 'discounted_total' to order responses… This
    change likely passes a null value to the recently extracted 'formatPrice'
    helper (introduced in b103ced763), which formats prices using '.toFixed()'.
    files: src/lib/pricing.js, src/routes/orders.js
    1793 in / 200 out, 2499ms, 0 repair(s)
```

**It correlates against a real git repository.** `bash
scripts/build-fixture-repo.sh` builds one at `fixtures/orders-api` — twelve real
commits, real shas, real `git log --numstat`. It is generated rather than
committed, with every date and identity pinned, so the shas are byte-identical
on every machine. Point `TARGET_REPO_PATH` at a real checkout to use one.

**The history is built to be hard.** A log with one obviously guilty commit
tests nothing. So the newest commit is innocent, three separate commits touch
the same file, and one scenario's most tempting candidate is the wrong answer.
The `--provider stub` baseline implements exactly the heuristic that history
defeats — blame the newest commit — which is what makes the comparison mean
something.

**`null` is a real answer.** Most incidents are not caused by a recent deploy.
A model with no way to decline invents a culprit, so `suspectedCommitSha` is
nullable, the prompt says not to return the best of a bad set, and a declined
correlation is still written to the database — "considered and declined" has to
stay distinguishable from "never ran".

**The answer is checked against the evidence.** A sha naming no candidate the
model was shown fails the correlation and writes nothing; a file not in the
named commit is dropped and reported. Zod proves the answer is well-*formed*; it
cannot prove it is *true to the evidence*, and a hallucinated sha would be
inherited by Phase 4 as established fact.

**No measurement yet.** In one observed run the model above named the right
commit and the naive baseline named the wrong one. That is n=1 on the positive
half — nothing has tested the `null` path, which is the half that actually
distinguishes this tier from its baseline. There is no correlation eval, so
there is no accuracy figure.

---

## Evals

Six golden cases — three real incidents, three benign windows that trip Tier 1
anyway. Each one is a prompt **captured from a real pipeline run**, not written
by hand, so the eval measures what the system actually sends.

```bash
pnpm eval                     # score against LLM_PROVIDER
pnpm eval --provider stub     # the statistical baseline, for comparison
pnpm eval --list              # the golden set and its labels
```

Three things are scored: the verdict (reported separately for benign and
incident cases), severity within one band, and **grounding** — whether
`affectedArea` actually appears in the evidence, or was invented. That last
check exists because a model returned `/orders/checkout` for a service with no
such endpoint.

### Current result — the claim holds

```
                             stub    llama3.2   gemini-2.5-flash   gemini-3.5-flash
dismissed benign windows     0/3     0/3        1/3                3/3
confirmed real incidents     2/3     3/3        3/3                3/3
severity within one band     2/6     3/6        6/6                6/6 (exact 6/6)
area grounded in evidence    6/6     5/6        6/6                6/6
```

The stub scores by counting which detectors fired — it **is** the statistical
judgement — and it dismisses nothing, because the three benign windows are
statistically indistinguishable from the three incidents. That 0/3 is not a
weakness of the stub; it is the reason Tier 2 exists, and the number that makes
the claim falsifiable.

A capable model dismisses all three, gets every severity exactly right, and
invents no locations. **The gap between those two rows is the value the LLM tier
adds, measured rather than asserted.** The result is identical across repeated
runs.

Each run also reports 2 schema repairs: twice per set the model returns something
that fails validation, and both times the repair loop recovers it. Without that
loop those would be errors instead of results.

### Getting there took being wrong twice

The eval's most useful output was not the score. It was discovering that **two of
the six labels were mine to fix**: `batch-job` and `rate-limit-storm` multiplied
*every* request's latency 6–8× while claiming in narration that the impact was
contained. A p95 of 1.4 s is a real incident whatever the cause — the model was
right and the labels weren't.

Fixing them properly, then diagnosing why a per-endpoint breakdown made one case
*worse*, is what produced the evidence packet's per-minute timeline. The whole
sequence is in [`DOCUMENTATION-EVALS.md`](./DOCUMENTATION-EVALS.md) §8–10,
including what was deliberately **not** done: no case was relabelled and the
prompt is byte-for-byte unchanged since before the first Gemini run.

---

## Layout

```
packages/
  shared/      Zod schemas + error-signature normalisation. The contract
               every other package imports.
  backend/     Fastify ingestion API, Drizzle schema, SQLite client,
               the Tier 1 detection pipeline (src/detection), the LLM
               provider layer (src/llm), the Tier 2 classifier
               (src/classification), commit correlation (src/correlation)
               and the golden-set evals (src/eval).
  generator/   Synthetic traffic with on-command anomaly injection.

scripts/       capture-cases.sh rebuilds the golden set from real runs.
               build-fixture-repo.sh builds the repository correlation reads.
fixtures/      The generated target repository. Gitignored — build it.
```

The split that matters throughout is **pure vs impure**. In `src/detection`,
`detectors.ts` and `stats.ts` have no database, clock or I/O, which is what makes
them provable with fixed inputs; `rollup.ts` and `engine.ts` own the database. In
`src/llm` and `src/classification` the same line runs between `context.ts`,
`structured.ts` and `json.ts` — pure, and tested with a fake provider — and
`classify.ts` and `calls.ts`, which persist. `src/correlation` splits the same
way: `commits.ts` parses `git log` and `grounding.ts` checks the answer, neither
touching anything, while `git.ts` spawns the subprocess and `correlate.ts` owns
the database.

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

**LLM providers are pluggable, and all free.** One `complete()` method behind
Gemini (primary), NVIDIA NIM (backup), OpenRouter (model comparison), Ollama
(offline dev loop) and a deterministic stub. No API key is needed for anything —
the stub is the default and runs the whole pipeline — and the project runs at $0.

**The expensive tier is opt-in.** `pnpm detect` never calls a model. Tier 1 is
free and can run every thirty seconds; Tier 2 spends quota, so it is a separate
command and an explicit `--classify` flag. That separation is also what keeps the
claim "the statistical layer works on its own" honest and checkable. Correlation
is a third command for the same reason — every stage that spends quota is an
explicit act.

**Every stage has a baseline it must beat.** The default provider is a
deterministic offline stub, and it is not a mock: for classification it applies
the *statistical* judgement Tier 2 exists to improve on, and for correlation the
*blame the newest commit* heuristic Phase 3 exists to improve on. Both are the
thing you would build without a model. The gap between the stub's score and a
real model's is the measured value of the LLM, which is why the stub's summaries
say "no model was called" rather than imitating one.

**Declining is a first-class answer.** Tier 2 can dismiss a flagged window;
correlation can name no commit. Both are recorded rather than treated as
absence, because a system that can only ever answer is a system whose answers
mean less.

---

## Data model

| Table | Purpose |
|---|---|
| `logs` | Raw entries. Indexed on `(service, timestamp)` — every detection query is time-windowed. |
| `metrics_rollup` | Per-minute aggregates so detection reads cheap summaries, not millions of rows. |
| `anomalies` | Tier 1 output (window + triggers), enriched by Tier 2 (severity, summary, `is_real_incident`, `affected_area`). Benign windows end up `dismissed`. |
| `correlations` | Suspected commit, confidence, reasoning, implicated files. A **null** sha is still a row — "considered and declined" is a finding, and it must stay distinguishable from "never ran". |
| `hypotheses` | Root cause and suggested fix. `applied` stays `false` — human gate. |
| `llm_calls` | Tokens and latency per call. This is what substantiates the two-tier cost claim. |

---

## Useful commands

```bash
pnpm typecheck            # strict TS across all packages
pnpm correlate            # Phase 3 — which commit, or none
pnpm correlate --preview  # the exact correlation prompt, no call
pnpm correlate --stats    # the correlation funnel

bash scripts/build-fixture-repo.sh    # the repo correlation reads

pnpm test                 # 129 unit tests, no network required
pnpm db:studio            # browse the database
sqlite3 data/dev.db "SELECT error_signature, COUNT(*) FROM logs \
  WHERE error_signature IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;"
sqlite3 -header -column data/dev.db "SELECT agent, provider, model, \
  count(*) AS calls, sum(input_tokens) AS tok_in FROM llm_calls GROUP BY 1,2,3;"
```

Reset to a clean slate:

```bash
lsof -ti:4000 | xargs kill -9
rm -f data/dev.db*
pnpm db:push
```
