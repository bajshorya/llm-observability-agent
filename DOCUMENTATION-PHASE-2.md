# Phase 2 — LLM Classification (Tier 2)

Phase 1 ends with rows in `anomalies` that have a window, a set of triggers, and
three null columns: `severity`, `summary`, `is_real_incident`. Phase 2 fills
them.

This document goes file by file: what each one does, how it works, and why it
was built that way.

---

## 1. What this tier is for

Tier 1 knows *that* something changed. It counted errors, compared a window to a
trailing baseline, and found the numbers unusual. What it cannot do is read.

Consider two windows with identical statistics — error rate up 40x, p95
unchanged, one new error signature at high volume:

- A deploy rolled out a null-dereference bug on the checkout path.
- A scheduled reconciliation job started and is logging expected "record already
  processed" warnings at error level.

No threshold separates these. The distinction is in the words, and reading words
is the one thing a language model is unambiguously better at than a z-score.
That is the whole argument for this tier, and it is also the argument for why
this tier does not do the first-pass scanning: a model reading every log line
would be slow, expensive, and no better at counting than `count(*)`.

So Tier 2 answers four questions, and only for windows Tier 1 already flagged:

| Field | Question |
|---|---|
| `severity` | How much does this matter? |
| `summary` | What is broken, in words an on-call engineer can act on? |
| `isRealIncident` | Is this an incident at all, or normal operations? |
| `affectedArea` | Which endpoint, dependency or subsystem? |

---

## 2. Shape of the tier

```
  anomalies WHERE severity IS NULL
             │
             ▼
   ┌──────────────────────┐
   │ context.ts (pure)    │  logs + rollups + triggers -> one evidence packet,
   │ evidence packet      │  budgeted: 8 signatures, 20 log lines
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ prompt.ts            │  system prompt: how to judge, what the fields mean
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐         ┌─────────────────────────┐
   │ structured.ts        │────────▶│ LlmProvider             │
   │ call -> extract JSON │         │ gemini | nvidia |       │
   │ -> Zod parse         │◀────────│ openrouter | ollama |   │
   │ -> repair on failure │         │ stub                    │
   └──────────┬───────────┘         └─────────────────────────┘
              │                                  │
              │ Classification                   │ LlmCallStats
              ▼                                  ▼
   ┌──────────────────────┐         ┌─────────────────────────┐
   │ anomalies            │         │ llm_calls               │
   │ severity, summary,   │         │ tokens, latency,        │
   │ is_real_incident,    │         │ repairs, succeeded      │
   │ status               │         └─────────────────────────┘
   └──────────────────────┘
```

Every arrow into a database is impure and lives in `classify.ts` or `calls.ts`.
Everything above them — context building, prompt, repair loop — has no database
import at all. That is the same pure/impure split Phase 1 used to make the
detectors provable, applied to the part of the system that is otherwise hardest
to test.

---

## 3. Files

```
packages/backend/src/
  llm/
    types.ts                    The provider boundary: LlmRequest, LlmCompletion, LlmProvider
    config.ts                   Temperature, token ceiling, retry and repair limits, default models
    http.ts                     POST + timeout + retry policy, shared by every network provider
    json.ts                     Extracting a JSON object from model text
    structured.ts               The repair loop. Prompt in, schema-valid object out
    calls.ts                    Cost accounting: writes llm_calls, reads the usage summary
    index.ts                    Provider factory from the environment
    structured.test.ts          22 tests over extraction, repair, cost accounting, the stub
    providers/
      gemini.ts                 Native generateContent API (primary)
      openai-compatible.ts      NVIDIA NIM, OpenRouter, Ollama — one implementation
      stub.ts                   Deterministic, offline, no key. The default
  classification/
    context.ts                  Pure evidence-packet builder and renderer
    prompt.ts                   The classifier system prompt, as a versionable constant
    classify.ts                 Orchestration: load, build, call, persist
    cli.ts                      `pnpm classify`
    context.test.ts             8 tests over budgeting, sampling and rendering
```

Also changed: `shared/src/schemas/agents.ts` (exported `llmAgents`),
`backend/src/env.ts` (provider configuration), `detection/engine.ts` (one merge
rule, see §10), `detection/cli.ts` (`--classify`).

---

## 4. The provider boundary

### `llm/types.ts`

```ts
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
```

One method. Streaming, tool calling and multi-turn conversation are all absent
because no agent in this system needs them: each one asks a single question and
parses a single JSON answer. Interface surface for capabilities we do not use is
surface every new provider has to implement.

`inputTokens` and `outputTokens` are nullable. Not every provider reports usage,
and a missing token count is not a reason to fail a classification — the cost
table records what it knows rather than inventing the rest.

### `llm/config.ts`

| Setting | Value | Why |
|---|---|---|
| `temperature` | 0.1 | Classification is a judgement, not a composition. The same window should classify the same way twice, or the eval harness measures noise. |
| `maxOutputTokens` | 800 | The answer is four short fields. This is a guard against a model that narrates, not a budget we expect to use. |
| `timeoutMs` | 45000 | Free tiers are slow. They should not be allowed to hang. |
| `maxHttpAttempts` | 3 | 429s are the steady state of a free tier. |
| `maxRepairAttempts` | 2 | A model that cannot produce the shape twice will not produce it on the fifth try, and every retry costs real tokens. |

Default models per provider live here too. Free-tier model identifiers are
churn-prone — providers retire and rename them — so `LLM_MODEL` overrides any of
them without a code change. That is the intended fix when one starts returning
404.

### `llm/http.ts`

One POST helper with the retry policy in one place.

Retried: 408, 409, 425, 429, 500, 502, 503, 504, and network/timeout failures. A
429 means "wait", not "this anomaly cannot be classified".

Not retried: 400, 401, 403, 404. A malformed request, a bad key or a retired
model fails identically forever; retrying only delays the message that tells you
which of the three it is.

Backoff is 500ms doubling, unless the server sent `Retry-After`, which is
honoured up to 30 seconds — the server knows its own quota window better than a
constant does.

### `llm/providers/gemini.ts`

The primary provider, on Google AI Studio's free tier. Uses the native
`generateContent` endpoint rather than Google's OpenAI-compatible shim, because
two things we want exist only on the native surface:

**`responseMimeType: "application/json"`.** JSON mode constrains syntax, not
semantics — a model can still return perfectly valid JSON with a severity of
`"quite bad"`, which is why Zod validation stays regardless. What it removes is
the most common failure mode, a correct object wrapped in a sentence of prose.

**`thinkingConfig: { thinkingBudget: 0 }`.** On Gemini 2.5 models, reasoning
tokens are billed against `maxOutputTokens`. Leave thinking on with an 800-token
ceiling and the model can spend the entire allowance reasoning and return an
empty candidate with `finishReason: MAX_TOKENS`. The symptom looks exactly like
a parse bug, which is why `parseGeminiResponse` names the finish reason in its
error. Classification is a short structured judgement over evidence that has
already been assembled; there is nothing here worth thinking tokens.

### `llm/providers/openai-compatible.ts`

NVIDIA NIM, OpenRouter and Ollama all speak `/chat/completions`. They differ in
base URL, auth header and which models exist — not in wire format. Three
near-identical files would be duplication pretending to be architecture.

One non-obvious case is handled: OpenRouter returns upstream failures as HTTP
200 with an `error` field in the body. Without an explicit check those surface
two layers up as an unhelpful parse error.

`response_format: { type: "json_object" }` is sent unconditionally. Support
varies across the three, and a provider that ignores it simply returns ordinary
text — which the extractor and the repair loop already handle. That is what
makes it safe to send everywhere rather than maintaining a capability matrix.

### `llm/providers/stub.ts`

The default provider, and not only a test fixture. It means:

- the full pipeline runs end to end for someone who has cloned the repo and has
  no API key;
- the unit tests exercise the real prompt-to-persistence path rather than a mock
  of it;
- `pnpm test` needs no network.

It scores severity by counting which detectors fired — `new_error_signature` and
`error_rate_spike` weigh 2, `latency_jump` weighs 1 — and calls it a real
incident at a score of 2 or more.

That is deliberately the *statistical* judgement, not a simulation of a semantic
one. And its summaries say so: *"Stub classification for orders-api… no model was
called."* A stub whose output reads like the real thing is a stub that will
eventually be mistaken for one, in a screenshot or a demo.

It parses `Service:` and `Triggers fired:` out of the rendered context, so those
two lines in `context.ts` are load-bearing beyond readability. Both files say so.

It returns `null` token counts rather than an estimate. The cost table is
evidence for a claim about real spend; inventing numbers for it would make every
number in it worth less.

### `llm/index.ts`

Resolves the provider from the environment once, and fails at construction with
the name of the variable to set:

```
LLM_PROVIDER=gemini requires GEMINI_API_KEY. Set it in .env, or use
LLM_PROVIDER=stub to run without a key.
```

Rather than on the first HTTP 401 halfway through a run. The distinction matters
when the run is unattended.

---

## 5. Structured output and the repair loop

### `llm/json.ts`

Every provider is asked for JSON and told to return nothing else. They mostly
comply. The failures are consistent enough to fix rather than retry: a ```json
fence, or a sentence of preamble.

`extractJsonObject` scans for a balanced top-level object while tracking string
state and escapes. The obvious implementation — `indexOf("{")` to
`lastIndexOf("}")` — gets this wrong on exactly the input this system exists to
process:

```json
{"summary":"Cannot read properties of null (reading '{}')","ok":true}
```

A truncated object returns `null` rather than a half-parse, which routes it into
the repair loop where it belongs.

### `llm/structured.ts`

The one function every agent calls. Nothing downstream of it consumes free-form
model text.

```ts
const { value, stats } = await generateStructured({
  provider, schema: classificationSchema,
  system: CLASSIFIER_SYSTEM_PROMPT,
  user: renderClassificationContext(input),
  agent: "classifier",
  anomalyId,
  onCall: recordLlmCall,
});
```

The loop: call → extract JSON → `schema.safeParse` → on failure, re-prompt with
the model's own output and the Zod issues, up to `maxRepairAttempts`.

**The repair prompt includes the previous response.** Telling a model "that was
invalid" without showing it what "that" was produces a second guess rather than
a correction. It also includes the original evidence, so the model is correcting
its answer, not answering a new question.

**Transport failures do not enter the repair loop.** HTTP-level retries have
already happened inside the provider, and no amount of re-prompting fixes a bad
key. A `LlmProviderError` records the cost of the failed call and propagates.

**There is no database import in this file.** Cost records go to an injected
sink, which is what lets the retry and validation logic be tested with a fake
provider and no I/O — the same property that makes the Tier 1 detectors
provable.

### `llm/calls.ts`

`recordLlmCall` writes one row per invocation, successful or not. The failed ones
matter most: a call that burned tokens on three repair attempts and still
produced nothing spent real quota, and a table that recorded only successes
would hide exactly the spend worth knowing about.

`llmUsageSummary()` aggregates per agent/provider/model — the granularity the
two-tier claim is actually made at.

---

## 6. Building the evidence packet — `classification/context.ts`

A five-minute window on a busy service is tens of thousands of log lines.
Sending them is impossible; sending the first N is worse than useless, because
the first N lines of an incident are the healthy traffic that preceded it.

So this file is a summariser, and it is pure — same window in, same prompt out,
no clock and no database. That is what makes the prompt reproducible, and what
makes a regression in classification quality attributable to the prompt rather
than to whatever the sampler happened to pick that run.

### The budget

| Limit | Value | Reasoning |
|---|---|---|
| `maxSignatures` | 8 | Ordered by frequency. The long tail is noise. |
| `maxErrorLines` | 15 | Sampled evenly across the window. |
| `maxHealthyLines` | 5 | A model reading only failures assumes total outage. A few successful requests in the same window are what distinguish "degraded" from "down". |
| `maxMessageChars` | 240 | Stack traces are the reason this exists. |

Doubling these roughly doubles input tokens for a marginal gain in evidence,
which is the wrong trade on a free tier.

### Even sampling

`sampleEvenly` takes items at regular intervals rather than a prefix or suffix.
An incident has a shape — it starts, escalates, sometimes recovers — and a slice
from one end shows one phase and hides the rest. A test asserts the last sampled
element comes from beyond the halfway point, which a prefix slice would fail.

### What the packet looks like

```
Service: orders-api
Window: 2026-08-10T12:29:00.000Z to 2026-08-10T12:34:00.000Z (5 min)
Triggers fired: error_rate_spike, new_error_signature

What the statistical detectors found:
- error_rate_spike: 67 errors in the window against a baseline of 0.57/min (sd 0.77, z=16.73)
- new_error_signature: "TypeError: Cannot read properties of null (reading <str>)"
  occurred 351 times and appears nowhere in the baseline hour

Window totals:
  requests 2444 | errors 353 (14.4%)
  latency p50 47ms | p95 179ms | p99 275ms

Error signatures (4):
  351x  TypeError: Cannot read properties of null (reading <str>)
        example: TypeError: Cannot read properties of null (reading 'toFixed')
  5x  Rate limit exceeded for client <num>
        example: Rate limit exceeded for client 1693
  ...

Log sample (20 lines, evenly spaced, drawn from 2444 in the window):
  12:29:05 INFO /orders 200 — GET /orders 200
  12:29:24 ERROR /orders/:id/refund 500 — TypeError: Cannot read properties of null (reading 'toFixed')
  ...
```

Triggers are described in words, not just named. `new_error_signature` on its own
means nothing to a model; "occurred 351 times and appears nowhere in the baseline
hour" is the fact that matters.

### Counts come from the log table, not the rollups

This is the one place Tier 2 deliberately departs from Phase 1's "detection
reads aggregates, never raw logs".

The rollup worker resumes from its last written bucket. Logs that arrive for a
minute already aggregated — a backfill, a late-delivering collector, an injected
demo scenario — leave that bucket stale. Tier 1 tolerates this: it compares
shapes, and an understated count still clears a 3σ bar.

A prompt cannot tolerate it. During verification the packet initially read
`errors 67` directly above a signature table listing `351x TypeError`. That hands
a model contradictory evidence and invites it to reconcile the two by guessing.
Counts are two indexed queries; correctness here is worth them. Latency
percentiles still come from the rollups, which are the only place per-minute
percentiles exist.

---

## 7. The prompt — `classification/prompt.ts`

A constant in its own file, because it is a version-able artefact. When
classification quality changes the question is always "what did the prompt say
at the time", and a prompt assembled inline from three template literals cannot
answer it.

It is built around what statistics cannot do:

- **Not every flagged window is an incident.** A deploy restart, a batch job, a
  load test and a dependency's maintenance window all produce the same
  statistical shape as an outage. The numbers cannot tell them apart. The log
  text usually can — which is why the model is reading it.
- **Weigh what the errors say, not only how many.** A hundred 429s from one
  client is rate limiting working correctly. Three null-dereference TypeErrors
  on a checkout path is a bug shipping to users.
- **Do not name a cause you cannot see.** A later stage correlates commits and
  diagnoses root cause. A confident guess here corrupts that stage's input.

Severity is defined explicitly rather than left to the model's intuition, and
`affectedArea` has an escape hatch — `"unknown"` — because a model with no
"I don't know" available will invent something.

---

## 8. Orchestration — `classification/classify.ts`

```ts
const result = await classifyAnomalies({ limit: 10 });
```

Loads unclassified anomalies, builds a packet for each, calls the model,
persists the verdict.

**"Unclassified" is `severity IS NULL`, not a status value.** Status tracks the
incident's lifecycle and later phases will move it; the null columns are the
ones Tier 1 declared it does not own. Keying off them means an anomaly is never
classified twice however its status later changes — which is the property that
makes `pnpm classify` safe to run on a loop.

**`limit` defaults to 10.** A backlog should not be able to empty a day's free
quota in one run.

**One failure does not stop the run.** A failed anomaly keeps its null severity
and is picked up next time, which is the right behaviour for the most likely
cause — a quota that resets in an hour.

**Row scan cap.** Up to 2000 error/warn rows and 200 info rows are pulled per
anomaly, purely to give the sampler a window to spread across. On a window
busier than that the scan takes the earliest rows, biasing the sample toward the
start of the incident. Accepted: the aggregate counts and the signature table
carry the shape, and the raw lines are illustrative rather than load-bearing.

---

## 9. The status lifecycle

Phase 1 left every anomaly `open` and documented that later phases own the
lifecycle. Phase 2 is that later phase for one transition:

| Verdict | Status after |
|---|---|
| `isRealIncident: true` | stays `open` — Phase 3 will move it to `correlated` |
| `isRealIncident: false` | `dismissed` |

Dismissal is the point of the tier. Statistics flagged it; reading it said
otherwise. Without this, the correlation agent would go looking for the commit
that caused a deploy restart.

---

## 10. The one change to Phase 1

Dismissal creates a problem in the detection engine. Its dedupe rule extended
only anomalies with status `open`, so a benign pattern that keeps going — a load
test, a long batch job — would produce a fresh anomaly on every subsequent run
once the first was dismissed, and each one would buy another LLM call to reach
the same verdict.

`persistAnomaly` now merges into `open` **or** `dismissed` anomalies within the
merge gap, with one guard:

```ts
const openAnomaly =
  recentAnomaly?.status === "dismissed" &&
  triggers.some((trigger) => !knownKinds.has(trigger.kind))
    ? undefined          // new signal — start a fresh anomaly, earn a new verdict
    : recentAnomaly;
```

Folding into a dismissed anomaly is only safe while nothing new has happened. A
trigger kind that was not part of what the classifier dismissed is evidence it
has not seen, so it starts a fresh anomaly rather than inheriting a dismissal —
otherwise a real incident beginning shortly after a benign one would never be
looked at.

---

## 11. Configuration

```bash
LLM_PROVIDER=stub          # gemini | nvidia | openrouter | ollama | stub
LLM_MODEL=                 # overrides the provider default
GEMINI_API_KEY=            # aistudio.google.com/apikey — free, no card
NVIDIA_API_KEY=            # build.nvidia.com — free developer tier
OPENROUTER_API_KEY=        # openrouter.ai/keys — :free model variants
OLLAMA_BASE_URL=http://localhost:11434
```

An unset key arrives as `""`, not `undefined`, so `env.ts` treats the empty
string as absent. That is what makes `.env.example` copyable as-is.

Every option is free. The project still runs at $0.

---

## 12. Commands

```bash
pnpm classify                      # classify up to 10 unclassified anomalies
pnpm classify --limit 3
pnpm classify --anomaly <id>       # one anomaly, even if already classified
pnpm classify --provider gemini    # override LLM_PROVIDER for this run
pnpm classify --preview <id>       # print the exact prompt, call nothing
pnpm classify --stats              # funnel + per-provider usage
pnpm detect --classify             # chain both tiers in one run
pnpm test                          # 77 unit tests

pnpm eval                          # score the golden set against LLM_PROVIDER
pnpm eval --provider stub          # the statistical baseline, for comparison
pnpm eval --list                   # the golden set and its labels
pnpm eval --show <name>            # a case's evidence packet
pnpm eval --capture <name> --expect benign --severity low --note "..."
```

`--preview` is the debugging tool that matters. When a classification looks
wrong, the first question is what the model was actually shown, and this answers
it without spending a call.

Tier 2 is opt-in on `detect` rather than automatic. Tier 1 is free and can run
every thirty seconds; Tier 2 spends quota and should not. Making it a flag keeps
the cheap loop cheap and the expensive one an explicit choice.

---

## 13. Verified behaviour

Full run against a scratch database — 120 minutes of healthy backfill, then the
`new-error` scenario:

```
$ pnpm detect
Window 12:29 to 12:34 (baseline 60 min):
  orders-api: clean

$ pnpm generate inject --scenario new-error --minutes 5
Injection complete: 1274 accepted, 0 rejected (381 errors, 29.9% error rate)

$ pnpm detect --classify
Tier 2 enabled — provider: stub
  orders-api: ANOMALY created  5cb16f57
    - error_rate_spike     67 errors in window; baseline 0.57/min ±0.77, z=16.73
    - new_error_signature  "TypeError: Cannot read properties of null (reading <str>)" x351
Tier 2 via stub (deterministic-stub):
  5cb16f57: CRITICAL (incident) — Stub classification for orders-api: 2 Tier 1
  signal(s) fired (error_rate_spike, new_error_signature)…
```

Against a real model (`llama3.2` via Ollama, no API key involved):

```
$ LLM_PROVIDER=ollama pnpm classify --anomaly 5cb16f57-…
Provider: ollama (llama3.2:latest)
  5cb16f57 orders-api: CRITICAL (incident)
    Error Rate Spike and New Error Signature detected in orders-api; multiple
    TypeErrors occurring on checkout path, rate limit exceeded for client, and
    order not found errors reported.
    area: /orders/checkout path
    1342 in / 56 out, 20998ms, 0 repair(s)
```

Correct verdict, correct severity, no repair needed, and the cost recorded:

```
$ pnpm classify --stats
Detection funnel:
  1 anomalies -> 1 classified (1 real, 0 dismissed)

LLM usage:
  classifier via ollama (llama3.2:latest)
    1 call(s), 0 failed, 0 repair(s), 1342 in / 56 out, avg 20998ms
```

Also verified:

- Re-running `pnpm classify` classifies nothing — the verdict is not recomputed.
- With the anomaly marked dismissed, a re-detect **extends** it rather than
  creating a second one, and makes no second LLM call.
- `--provider gemini` with no key fails immediately with the variable to set.

One honest observation from the real run: `affectedArea` came back as
`/orders/checkout path`, but the endpoints in the logs are `/orders`,
`/orders/:id` and `/orders/:id/refund`. A 3B model filled a plausible-sounding
path where the prompt told it to say `unknown`. This is the exact failure the
golden-set evals in §15 exist to measure, and a reason the free tier's larger
models are the intended default.

---

## 14. Trade-offs

| Decision | Buys | Costs |
|---|---|---|
| **Separate `classify` command** | Tier 1 stays free, fast, and runnable with no key | Two commands instead of one; `--classify` bridges them |
| **Stub as the default provider** | Repo runs end to end with no account; tests need no network | A first-time run shows a scored stub, not model prose |
| **Repair loop capped at 2** | Bounded cost on a model that cannot follow the schema | A model that would have succeeded on attempt 4 fails |
| **JSON mode + Zod, not native schema binding** | Portable across five providers; validation is real, not assumed | Occasional repair round-trip a bound schema would avoid |
| **Counts from raw logs** | Internally consistent evidence packet | Two extra indexed queries per anomaly |
| **Dismissed anomalies are mergeable** | A benign ongoing pattern costs one LLM call, not one per run | A new incident within the merge gap with the *same* trigger kinds inherits the dismissal |
| **`severity IS NULL` means unclassified** | Never classifies twice; safe to run on a loop | Re-classifying requires `--anomaly` explicitly |
| **Sampling instead of full windows** | Bounded token cost regardless of traffic | The model sees ~23 lines of evidence, not the window |
| **Sampling by shape, not uniformly** | A one-off deploy banner is never crowded out by routine traffic | The sample under-represents how dominant the common shapes are; the signature counts carry that instead |
| **Golden cases captured, not written** | The eval measures the prompt the system actually sends | Re-capturing is needed whenever the context builder changes |
| **Eval calls excluded from `llm_calls`** | The cost table stays an honest record of incident spend | Eval spend must be read from the eval's own output |

---

## 15. Known limitations

**The dismissal claim is currently unproven.** See §17: on the golden set, no
model available for local testing dismisses a benign window. The harness that
measures this exists; the result it reports is a failure.

**Row-scan bias.** Above 2000 rows of either kind in a window the sample skews
toward its start (§8).

**Single-service context.** The packet describes one service. Cross-service
cascades are a stretch goal in the architecture document and nothing here
prevents it, but nothing here implements it either.

**No token-level cost in currency.** `llm_calls` records tokens and latency, not
dollars — every provider in use is free, so a cost column would read `0.00` and
imply precision that isn't there. Pricing belongs with whichever paid provider
gets added, if one ever does.

**Prompt caching is unused.** The system prompt is stable across every call and
would cache well on providers that support it. At current volume the saving is
theoretical.

---

## 16. The eval harness

### Why the golden set is half benign

Every window this system had ever classified was a genuine incident. All three
original generator scenarios are real bugs. So the central claim of Tier 2 —
that it can tell a deploy restart from an outage — had never been tested once.
The prompt argues for it at length; nothing verified it.

Three benign scenarios now exist, and **every one of them trips Tier 1**. That
is the requirement, not a side effect: a benign scenario the detectors ignore
tests nothing, because it never reaches the classifier.

| Scenario | Tier 1 fires | Why it is benign |
|---|---|---|
| `deploy-restart` | `error_rate_spike` + `new_error_signature` | Connection-refused burst confined to a rolling restart, recovered inside the window |
| `batch-job` | `latency_jump` + `new_error_signature` | Scheduled reconciliation saturating the pool; the only errors are its own duplicate-skip warnings |
| `rate-limit-storm` | `latency_jump` + `new_error_signature` | One client throttled correctly; 429s are the protection working |

`deploy-restart` is the sharpest of the three: statistically it is
indistinguishable from `new-error`, the null-price bug. Both fire the same two
detectors with comparable magnitudes. Everything separating them is text.

### Making the benign cases fair

A benign scenario is only benign if the evidence says so, which meant the
generator had to gain two capabilities, and the context builder had to stop
throwing away the lines that mattered.

**Phased scenarios.** `Scenario.profile` now receives a `progress` argument, 0
at the start of the injection and approaching 1 at its end, so a scenario can
have an arc. "Already recovering" is one of the strongest benign signals there
is, and it cannot be expressed by a profile that is constant across the window.

**Narration.** `Scenario.context` emits lines that say what is happening —
`orders-api v1.4.2 starting up (deploy 7c1e044)`, `Rollout complete: 3 of 3
instances healthy`, `Nightly reconciliation batch 4609 started`. Without these
the benign windows would be genuinely indistinguishable from incidents, and an
eval built on them would measure an impossible task rather than a hard one.

### Two bugs the golden set found immediately

Both were in code that already passed its tests. Neither would have been caught
by anything except trying to capture a real benign case.

**The sampler discarded the only line that mattered.** The healthy-line sample
was drawn uniformly, on the assumption that routine traffic is interchangeable.
It is — but the deploy banner is one line among two thousand, and uniform
sampling dropped it, leaving a window no reader could have judged correctly.

The fix generalises the observation: a line is informative roughly in proportion
to how *rare its shape is*. Twenty copies of `GET /orders 200` say what one copy
says. `sampleDiverse` groups lines by normalised message shape — reusing the
same collapsing the error signatures already do — and hands out the budget a
slot at a time, cycling rarest-first, so every shape gets its first slot before
any shape gets a second. Rare lines are guaranteed a place; common ones still
fill whatever is left.

**The scan cap hid the second half of the window.** Healthy rows were capped at
200 per anomaly, an order of magnitude below the error cap, on the same
assumption. On a service handling 240 requests a minute that covered the first
twenty-five seconds and silently discarded every announcement made after it —
including `Rollout complete`, the line stating the incident was over. The caps
are now equal at 2000.

**A third, smaller one:** injections were not minute-aligned, while rollup
buckets and detection windows are. The first generated minute was therefore
partly clipped out of the window it was meant to land in, which is how a deploy
banner emitted at offset zero ended up outside the window it explains.
`generateHistory` now ends on a minute boundary.

### What is scored

| Measure | Rule |
|---|---|
| **Verdict** | `isRealIncident` matches the label. Reported separately for benign and incident cases. |
| **Severity** | Within one band of the label. Exact match reported but not headlined. |
| **Grounding** | Does `affectedArea` appear in the evidence? |

The verdict split is the important design choice. A model that answers "critical
incident" to everything scores 100% on the incident half, and a single blended
accuracy number would hide that completely — which is not hypothetical, see
below.

Severity is scored within one band because the line between high and critical is
a matter of taste while the line between low and critical is not. Demanding
exact agreement would score agreement with one labeller's judgement.

**Grounding** is a mechanical check for a specific observed failure. Asked to
classify a window whose endpoints were `/orders`, `/orders/:id` and
`/orders/:id/refund`, llama3.2 answered `"/orders/checkout path"`. Verdict and
severity both right; the field naming *where* was fabricated. The prompt offers
`"unknown"` for exactly this case, and the interesting question is whether a
model takes that option or fills the space. If the answer names a path, the path
has to appear in what the model was shown — no judgement, no second model
grading the first one's homework.

**Summary wording is deliberately not scored.** Grading prose needs a human or
an LLM judge, and a metric that cannot be trusted is worse than no metric.

Eval calls are not written to `llm_calls`. That table backs a claim about what
running the system costs; filling it with calls that classified no anomaly would
inflate the exact number it exists to substantiate.

---

## 17. What the eval found

Run against the stub, which scores by counting which detectors fired — the
statistical judgement, with no reading involved:

```
  dismissed benign windows   0/3  (0%)
  confirmed real incidents   2/3  (67%)
  severity within one band   2/6  (exact 1/6)
```

Then against llama3.2 (3.2B, local, via Ollama):

```
  dismissed benign windows   0/3  (0%)
  confirmed real incidents   3/3  (100%)
  severity within one band   3/6  (exact 2/6)
  area grounded in evidence  5/6  (83%)
  cost                       7701 in / 284 out, 0 repair(s), mean 7965ms
```

**The model dismissed nothing.** It answered `critical` and `isRealIncident:
true` to all six cases, including a rolling restart that recovered inside the
window with two log lines saying so. Its perfect incident score is an artefact
of always answering the same thing — which is precisely what the split scorecard
is built to expose, and what a single "83% accurate" headline would have hidden.

It also reproduced the grounding failure the check was written for, on a
different case than the one that motivated it.

**The honest reading:** on the evidence available, Tier 2 currently adds nothing
over Tier 1 on the judgement it exists to make. A 3B model is far below what the
design assumes — Gemini 2.5 Flash is the intended default and is free — but that
is a hypothesis, and until it is run the claim in §1 of this document is
unproven. The harness now makes it a measurement rather than an argument.

**What was deliberately not done:** tuning the prompt until the numbers improve.
Six cases and a 3B model is nowhere near enough signal to justify prompt changes,
and a prompt fitted to this set would score well on this set and mean nothing.
The next step is a run against a capable model, not a rewrite.

---

## 18. What Phase 2 hands to Phase 3

Rows in `anomalies` with `is_real_incident = 1`, a `severity`, a plain-English
`summary`, an `affected_area` implicated in the text of that summary, and status
still `open`. Benign windows are already `dismissed` and will not be correlated.

The correlation agent gets a filtered, described, prioritised list — not a pile
of statistical flags. It also gets the two things it needs to reuse:
`generateStructured` with `correlationSchema`, and a provider that already works.

The funnel is the number to quote: every anomaly Tier 1 merged instead of
creating, and every window it never flagged at all, is a model call that never
happened.
