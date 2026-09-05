# The AI Layer, In Detail

Every other document in this repository is organised by phase — what was built,
when, and what it cost. This one is organised by **subject**: the LLM
engineering that runs through all of them.

It answers, in order: what an agent is here, how a model is called, how its
output is forced into a contract, how the evidence it sees is chosen, whether
any of that is RAG, and how the whole thing is measured.

If you read one other file alongside this, make it
`packages/backend/src/llm/types.ts` — the entire provider contract is one method.

---

## Contents

1. [The one-sentence version](#1-the-one-sentence-version)
2. [What "agent" means here](#2-what-agent-means-here-and-what-it-does-not)
3. [The provider layer](#3-the-provider-layer-one-method)
4. [Structured output and the repair loop](#4-structured-output-and-the-repair-loop)
5. [Context construction — the real work](#5-context-construction--the-real-work)
6. [Is this RAG? No, and the difference matters](#6-is-this-rag-no-and-the-difference-matters)
7. [Prompt engineering, and the rule that governs it](#7-prompt-engineering-and-the-rule-that-governs-it)
8. [Declining as a first-class output](#8-declining-as-a-first-class-output)
9. [Grounding: catching what a schema cannot](#9-grounding-catching-what-a-schema-cannot)
10. [Cost, and the claim it substantiates](#10-cost-and-the-claim-it-substantiates)
11. [Evaluation](#11-evaluation)
12. [What is deliberately absent](#12-what-is-deliberately-absent)

---

## 1. The one-sentence version

**Cheap statistics decide what is worth reading; a language model reads only
that, four times at most, and every answer it gives is forced through a Zod
schema and checked against the evidence it was shown.**

Everything below is an elaboration of that sentence.

---

## 2. What "agent" means here, and what it does not

The word is overloaded to the point of uselessness, so this project pins it
down. An **agent** is *a role that calls an LLM with its own prompt and its own
output schema*.

Three are declared in `packages/shared/src/schemas/agents.ts`, and all three are
now built.

| Agent | Question | Schema |
|---|---|---|
| `classifier` | Is this flagged window a real incident, how bad, and where? | `classificationSchema` |
| `correlator` | Which recent commit most likely caused it — or none? | `correlationSchema` |
| `root_cause` | Why did that change break it, and what should change? | `hypothesisSchema` |

Tier 1 — the statistical detection stage — is not on this list, because it calls
no model at all. That is the point of it.

**What these agents are not:** they do not use tools, they do not loop, they do
not plan, and they never call each other. Each one asks a single question, reads
a single evidence packet, and returns a single JSON object. The "agentic"
property this system claims is narrower and more defensible than autonomy:

> The correlation stage reads two independent data sources — runtime behaviour
> and source history — and produces a causal conclusion that is present in
> neither on its own.

That is what a pipeline of prompts does not do, and it is the whole reason the
correlator exists as a separate stage rather than a bigger classifier prompt.

**Why separate prompts rather than one mega-prompt:** each is cheaper, each is
independently evaluable, and each one's spend is attributable in `llm_calls`. A
single prompt that answered all three questions would be one number in the cost
table and one score on a scorecard, and neither could tell you which part was
failing.

---

## 3. The provider layer: one method

```ts
interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
```

That is the entire contract. Five provider *names* are configurable — `gemini`,
`nvidia`, `openrouter`, `ollama`, `stub` — across **three** implementation
files, because `nvidia`, `openrouter` and `ollama` are all OpenAI-compatible and
share one. Gemini gets its own because two things it offers exist only on the
native surface: JSON mode, and the ability to disable thinking.

**Streaming, tool calling and multi-turn are all absent**, because no agent here
needs them. Surface for capabilities you do not use is surface every new
provider must implement, and keeping it out is what makes adding a provider a
one-file job.

**Token counts are nullable.** Not every provider reports usage, and a missing
count is not a reason to fail a call. The cost table records what it knows and
says `not reported` for the rest, rather than estimating — see §10.

### The stub is the default, and it is not a mock

`LLM_PROVIDER` defaults to `stub`, which makes no network call. Three reasons,
none of them "for tests":

1. The whole pipeline runs end to end for someone who has just cloned the repo
   and has no API key.
2. The unit tests exercise the **real** prompt-to-persistence path; only the
   model itself is substituted.
3. `pnpm test` needs no network and costs nothing.

More importantly, the stub is a **baseline** — the thing each tier has to beat:

| Agent | Stub behaviour | Why that is the right control |
|---|---|---|
| `classifier` | scores severity by counting which detectors fired | that *is* the statistical judgement Tier 2 exists to improve on |
| `correlator` | names the newest candidate commit | "blame the last deploy" is what you would build without a model |
| `root_cause` | declines | there is no cheap non-model way to derive a mechanism from a diff, so a stub attempt would be a straw man rather than a control |

The classifier stub scores **0/3** on the benign half of the golden set. That
number is not a deficiency to fix — it is what makes the two-tier claim
falsifiable, and the gap between it and a real model is the measured value of
the LLM.

Stub output **announces itself** ("no model was called"). A stub whose prose
reads like the real thing will eventually be mistaken for it in a screenshot or
a README, and that is an expensive kind of confusion.

### Configuration

| Setting | Value | Why |
|---|---|---|
| `temperature` | 0.1 | Judgement, not composition. Measured: decisions are stable across repeats; only confidence moves ±0.05 |
| `maxOutputTokens` | 800 | The answer is a few short fields. A guard against a model that narrates, not a budget |
| `timeoutMs` | 45 000 | Free tiers are slow; they should not hang |
| `maxRepairAttempts` | 2 | A model that cannot produce the schema twice will not produce it on the fifth try, and each retry costs tokens |

---

## 4. Structured output and the repair loop

`llm/structured.ts` is the single path every agent's output takes. Nothing
downstream ever consumes free-form model text.

```
  provider.complete()
        │
        ▼
  extract JSON from the response      json.ts — models add prose and fences
        │
        ▼
  Zod parse against the agent's schema
        │
        ├── ok      → typed value + LlmCallStats
        └── invalid → re-prompt with the model's OWN output and the
                      specific Zod errors, up to 2 more times
```

**JSON mode constrains syntax, not semantics.** Gemini's
`responseMimeType: "application/json"` guarantees the response parses. It does
not guarantee `severity` is one of four allowed strings — a model can return
perfectly valid JSON with a severity of `"quite bad"`. Zod is what catches that,
which is why validation stays regardless of provider capability.

**The repair prompt includes the failure.** Handing the model its own output
plus the exact validation errors is markedly more effective than asking again,
because the second attempt is a correction task rather than a repeat of the
task that just failed.

**Repairs are counted, not hidden.** `llmCallStats.repairAttempts` is recorded
per call, so a model that only produces valid output on the third try is
*visibly* worse than one that gets it right first time — rather than looking
identical behind a successful parse.

**Failures are recorded too.** A call that burned tokens and returned nothing
still spent quota. `llm_calls` includes it, because a cost table that omits
failures flatters exactly the number it exists to substantiate.

---

## 5. Context construction — the real work

This is where most of the engineering actually is, and it is the part most
similar systems get wrong by sending everything.

A five-minute window on a busy service is tens of thousands of log lines.
Sending them all is impossible. **Sending the first N is worse than useless** —
the first N lines of an incident are the healthy traffic that preceded it.

Each agent has a `context.ts` that is **pure**: same input, same prompt out, no
clock, no database, no subprocess. That purity is what makes a regression in
quality attributable to the prompt rather than to whatever the sampler happened
to pick that run.

### Tier 2's packet: four views, each answering a different question

| View | Answers | Budget |
|---|---|---|
| Window totals | **how much** — requests, errors, p50/p95/p99 | — |
| Per-minute timeline | **when** — growing, steady, or already over? | 20 minutes |
| Per-endpoint breakdown | **where** — one path slow, or all of them? | 6 endpoints |
| Sampled log lines | **what** — what does the failure actually say? | 15 error + 8 healthy |

Plus 8 error signatures, and 240 characters per message (stack traces are why
that cap exists).

The last two views were added **after measurement, not intuition**. Without the
endpoint breakdown, "the service is slow" and "one background job is slow while
users are fine" are identical evidence with opposite verdicts. Without the
timeline, a burst that stopped after sixty seconds is indistinguishable from
five minutes of steady failure — and a real classification was wrong for exactly
that reason before it existed.

### Two sampling rules, and why uniform sampling is wrong

**`sampleEvenly`** spreads across time, so an incident's *arc* is visible. It
starts, escalates, sometimes recovers; a slice from either end shows one phase
and hides the rest.

**`sampleDiverse`** is the interesting one. It groups lines by normalised
message shape and allocates the budget round-robin, rarest shape first.

The premise: **a line is informative roughly in proportion to how rare its shape
is.** Twenty copies of `GET /orders 200` say exactly what one copy says. A single
`v1.4.2 starting up` explains the entire window.

This was not a theory. The first captured `deploy-restart` case dropped its
startup banner — one line among two thousand routine ones — leaving a benign
window that no reader, human or model, could have distinguished from an outage.
Volume had crowded out the only line that mattered. That failure is why the
function exists.

### Normalisation: the idea that powers two things and obstructs a third

`shared/src/signature.ts` strips variable detail so recurring failures collapse
onto a stable key:

```
Order 12778 not found  ─┐
Order 44012 not found  ─┼─→  Order <num> not found
Order 90210 not found  ─┘
```

That single idea powers the new-signature detector (without it every error looks
novel) and the evidence sampler (one example per shape instead of twenty copies).

**And it makes correlation harder**, which is worth knowing before it surprises
you. `reading '<str>'` matches nothing in a repository; `reading 'toFixed'`
matches a file about formatting money. So the correlation packet prints the
**raw sample alongside the collapsed shape** rather than instead of it. The
packet was written without the raw line first, and its own test caught it.

### Phase 3's packet: two halves with a seam

The first packet built from two sources — the incident, and the candidate
commits — laid out so the seam is visible. Budget: 25 commits, 12 files each,
400 characters of body, 300 of raw error text.

The body budget is generous relative to Tier 2's 240-character log lines, and
the fixture shows why: the two most confusable candidates touch the *same two
files* with similar subjects, and only their bodies separate them.

### Phase 4's packet: the one with no budget

Symptom, attribution, and the blamed commit **with its full diff**, uncapped.

Every other renderer truncates. This one does not, because a root cause found in
the truncated half is a root cause missed, and this stage runs on at most one
commit for at most one incident — the funnel has narrowed four times by the time
anything reaches it.

---

## 6. Is this RAG? No, and the difference matters

**There is no retrieval-augmented generation in this system.** No embeddings, no
vector store, no similarity search, no chunking, no re-ranker, no `k` nearest
neighbours. `grep -r "embedding\|vector\|cosine"` over the source returns
nothing.

That is a deliberate choice, not an omission, and the reasoning is worth setting
out because the *problem* RAG solves is genuinely present here.

### The problem is the same

RAG exists because a model cannot see everything, so something must decide what
it sees. That is exactly the problem of §5: tens of thousands of log lines,
a context window, and a decision about which two dozen lines to send.

### The solution is different, because the selection criterion is different

RAG selects by **semantic similarity to a query**. You embed a question, embed
your corpus, and retrieve the chunks nearest in vector space. It is the right
tool when relevance is fuzzy, the corpus is unstructured prose, and no cheaper
signal exists.

None of those hold here:

| | RAG's assumption | This system |
|---|---|---|
| Relevance signal | fuzzy semantic similarity | **structural and statistical** — which detector fired, which minute, which endpoint, which message shape |
| Corpus | unstructured prose | structured records with a schema, timestamps, and a normalisation function |
| The query | a natural-language question | a *time window* that statistics already selected |
| Cheaper signal | none | z-scores, percentiles, and signature novelty, all free |

The selection here is **deterministic**. The same window always produces the
same packet, because the builder is a pure function of the window. That is what
makes the golden cases meaningful — a stored prompt is a fixed artefact, and a
score is comparable across prompt versions. Embedding-based retrieval is
approximate by construction, and would have made every eval number a moving
target.

It is also **free**. Normalisation, sampling and aggregation cost microseconds
and no API calls. Embedding a corpus of logs costs money per line, continuously,
for a relevance signal weaker than the one already available.

### Where the analogy does hold

Two things here are recognisably retrieval, and calling them that is fair:

**`sampleDiverse` is a diversity re-ranker.** It solves the problem MMR
(maximal marginal relevance) solves in a RAG pipeline — stopping near-duplicate
chunks from crowding out the one rare item that matters — using normalised
message shape as the similarity function instead of cosine distance over
embeddings. Same failure mode, same fix, a cheaper and exact similarity measure.

**Phase 3's collector is retrieval over a second corpus.** `git log --numstat`
bounded by `--since`, `--until` and `--max-count` is a query against source
history, and `defaultLookback` (48 hours, 25 commits) is the `k`. It retrieves
by *time and reachability* rather than by similarity, because "which commits
could have caused something at 19:02" has an exact answer and does not need an
approximate one.

### What would change the answer

RAG would start earning its keep if the system had a corpus where similarity is
the only available signal — historical incident write-ups, runbooks, past
postmortems, a large body of documentation. "Find me the three past incidents
that look like this one" has no z-score, and that is precisely the shape of
question embeddings are good at.

That is a real and obvious extension. It is not built, and claiming it were
would be the kind of thing this project's documents exist to avoid.

---

## 7. Prompt engineering, and the rule that governs it

Each agent's prompt is a **constant in its own file**, not assembled inline.

```
  CLASSIFIER_SYSTEM_PROMPT   how to judge          ← stable, versioned
  rendered context           what to judge         ← per anomaly, varies
```

A prompt is a *versionable artefact*. When quality changes the question is
always "what did the prompt say at the time", and a prompt assembled from three
template literals scattered across a function cannot answer that. Here `git log`
can. It also caches well, being identical across every call.

### The rule: do not tune the prompt against the eval

All three prompts have been **byte-for-byte unchanged since before their first
real model run**, including through runs that scored badly.

Six or seven cases is not enough signal. A prompt fitted to that set scores well
on it and means nothing. The instruction is to fix **evidence and test data**
instead, and to be able to justify each change without reference to the score it
produced.

**This rule has been tested once, and holding it paid.** The correlation eval
exposed a repeatable failure that a prompt edit would plausibly have fixed.
Instead of editing, the same cases were run against two more models — all three
failed identically, which located the problem in the *evidence* (no diff
content, so an innocent commit could not be exonerated) rather than in the
instructions. A prompt patch would have papered over that and scored better.

`correlation/prompt.test.ts` and `diagnosis/prompt.test.ts` enforce the rule
mechanically: no fixture identifier, no commit sha, no worked example. Verified
by inserting a leak deliberately and watching the guards fire.

### What each prompt is built around

| Prompt | Built around |
|---|---|
| Classifier | everything statistics cannot do — a deploy restart, a batch job and an outage share a shape but not a vocabulary |
| Correlator | three failures a capable model walks into unprompted: recency, filename matching, and answering from the list rather than declining |
| Root cause | a fix that cannot be checked, agreeing by default, and restating the error instead of explaining the mechanism |

The correlator's hardest instruction to get right was recency. "Recent is not
guilty" is easy to state and easy to overshoot — recency *is* evidence. The
prompt says **"timing narrows the field; it does not decide it"**, because a
prompt that told the model to disregard recency would trade one bias for another
and be wrong more often on real incidents, where the guilty commit usually *is*
recent.

---

## 8. Declining as a first-class output

The single most load-bearing idea in the AI layer.

> A model with no way to decline does not decline. It invents.

Every agent therefore has an explicit way out, and each was added for a reason:

| Agent | Escape hatch | Why |
|---|---|---|
| `classifier` | `isRealIncident: false`, `affectedArea: "unknown"` | a deploy restart is not an incident, and a model with no "unknown" invents a location |
| `correlator` | `suspectedCommitSha: null` | most incidents are not caused by a recent deploy |
| `root_cause` | `explainsTheFailure: false` | this stage is *handed* an attribution and asked to explain it |

And each is **measured**, not just offered:

- The classifier's benign half is 3 of 6 golden cases. The statistical baseline
  scores 0/3 on it; a capable model scores 3/3. That gap is the value of Tier 2.
- The correlator's decline axis is 4 of 6 cases, scored **separately** from
  attribution and never averaged with it. A model that always names something
  scores 100% and 0%; one that always declines scores the reverse; blended, both
  read as a respectable half.
- `explainsTheFailure` earned its place on its **first real call**: handed a
  correlation that had blamed a CI-workflow commit, the model read the diff and
  returned `false` at 0.95 confidence — "it does not alter any application code
  that would be deployed".

A stage that can only agree with its input is not a stage.

---

## 9. Grounding: catching what a schema cannot

Zod proves an answer is well-**formed**. It cannot prove the answer is **true to
the evidence**, because it has never seen the evidence.

Two grounding checks exist, and the difference between them matters.

**`eval/grounding.ts`** — did the classifier invent a location? Deliberately
mechanical: if `affectedArea` names a path, every path must appear verbatim in
the context; otherwise ≥60% of its words of four or more characters must appear.
Declining (`"unknown"`) counts as grounded. An LLM judge was rejected — a model
grading a model is a metric that cannot be trusted, and a metric that cannot be
trusted is worse than none.

**`correlation/grounding.ts`** — did the correlator invent a commit? This one
runs **in the pipeline**, not only in the eval, because a hallucinated sha would
be written to `correlations` and inherited by Phase 4 as established fact.

Its two failure modes are deliberately asymmetric:

| Kind | Treatment | Why |
|---|---|---|
| **Invented sha** | fatal; nothing written | the sha *is* the causal claim. Coercing it to `null` would record a hallucination as a considered "no commit explains this" — corrupting the one measurement the nullable field exists to make possible |
| **Invented file** | dropped and reported | the sha still points at a real diff a human can open, so the answer stays checkable |

Prefixes resolve **against the candidate list**, not by asking git, so
resolution cannot succeed for a commit the model was never shown — the lookup
and the grounding check are the same operation. An ambiguous prefix is treated
as ungrounded rather than resolved to the first match; guessing between two
commits would attribute an incident to a coin flip.

**What grounding cannot catch:** a fabricated claim *about* real evidence. A 3B
model once reasoned that "the error text mentions `discounted_total`" when that
string appeared only in a commit message and the errors were upstream timeouts.
The sha was real and the file was in that commit, so both guards passed.
Checking that would need a model grading a model, which §11 rules out.

---

## 10. Cost, and the claim it substantiates

`llm_calls` records one row per invocation: provider, model, agent, input and
output tokens, latency, repair attempts, and success.

It exists to make one claim checkable:

> The LLM fires on only a small fraction of windows, and here are the numbers.

The funnel narrows four times, and each narrowing is a call that never happened:

```
  every window              → what Tier 1 flagged           (free, no model)
  what Tier 1 flagged       → what Tier 2 called real       (1 call each)
  what Tier 2 called real   → what Phase 3 correlated       (1 call each)
  what Phase 3 correlated   → what it ATTRIBUTED            (1 call each)
```

Repeated firings of one incident **merge into a single anomaly row**, so one
incident costs one classification — not one per detection run. That merge rule
is a cost decision as much as a data-modelling one.

**No cost in currency.** Tokens, not dollars, because every provider in use is
free and a column reading `0.00` would imply a precision that is not there.

**Eval calls are never written to `llm_calls`.** That table is the accounting
behind a claim about what *running the system* costs; filling it with calls that
classified no anomaly would inflate exactly the number it exists to
substantiate. `generateStructured` takes an optional injected sink for this
reason.

---

## 11. Evaluation

Covered in full in `DOCUMENTATION-EVALS.md`; this is the shape of it.

**Two golden sets**, both stored as the *entire rendered prompt as a fixed
string*. Storing a structured input and re-rendering at eval time would measure
whatever the renderer does today; a stored string is a fixed artefact of one
real pipeline run, so scores stay comparable across prompt versions. The cost is
real and accepted: when the packet changes, cases must be re-captured.

**The classifier set** — 6 cases, half benign. A set of only real incidents
cannot distinguish a competent classifier from one that answers "critical
incident" to everything.

**The correlation set** — 6 cases, 4 of them declines *for four different
reasons*: an upstream dependency, that dependency degrading, a load change, and
a real bug whose cause is older than the lookback. Two decline cases that both
mean "upstream is failing" measure one thing twice.

**Scorecards split, and never blend.** The lesson was learned the hard way: a
model answering "critical incident" to everything scored 3/3 on the incident
half and read as mediocre rather than pathological. Split, it reads 3/3 and 0/3
and is instantly diagnostic.

**Failures are counted separately from wrong answers.** A case that produced no
schema-valid response is a provider failure — usually quota — not bad judgement.
Averaging them would blur two completely different problems.

### Three things the harness found about itself

These matter more than any score it produced.

**Cases inherited the classifier's variance.** A correlation packet embeds Tier
2's verdict, so re-capturing silently changed how hard the set was — one case
failed on three models in one capture and passed on two in the next, with no
packet change. Fixed by pinning the verdict as a fixture.

**Captures were not reproducible.** The generator's PRNG was always seeded, but
its *timestamps* were wall-clock, so runs landed on different minute boundaries
and aggregated ~2% apart — enough to flip a decision. Fixed with `--end-at`.
Verified by capturing twice and diffing: byte-identical.

**A decline case was mislabelled by its author, and a model found it.** It
originally emitted an error naming `created_at`, and a model blamed the commit
that changed `created_at` formatting — a substantive, checkable mechanism and a
*good* answer. The scenario was changed, not the label.

**No eval for Phase 4.** "Is this mechanism right" and "is this fix good" are
not boolean, and the two evals that work both hang on a question with an
unambiguous answer. Grading prose needs a human or a second model marking the
first one's homework.

---

## 12. What is deliberately absent

Listing these is the point, not an apology.

| Absent | Why |
|---|---|
| **RAG / embeddings / vector store** | the relevance signal here is structural and statistical, and free. See §6 |
| **Tool calling** | no agent needs it. Each asks one question and parses one answer |
| **Multi-turn conversation** | the repair loop is the only second turn, and it is a correction, not a dialogue |
| **Agent-to-agent messaging** | stages hand off through the *database*, so every intermediate conclusion is inspectable and attributable |
| **Autonomous action** | `hypotheses.applied` defaults to false and no code writes it. There is no `--apply` |
| **An LLM judge in the eval** | a model grading a model is a metric that cannot be trusted |
| **Streaming** | nothing consumes partial output; everything waits for a complete JSON object |
| **Fine-tuning** | the failures found were evidence problems and label problems, not capability problems |

The last row is the summary of the whole document. Almost every quality problem
this project measured turned out to be about **what the model was shown**, not
about the model or the prompt. That is where the engineering went.
