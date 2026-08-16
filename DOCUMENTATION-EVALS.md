# Evaluation Harness — Full Reference

Phase 2 built a classifier and argued that it can tell a deploy restart from an
outage. This work tests that argument, finds it unproven, and says so.

It covers three things: benign scenarios for the generator, two fixes to the
evidence builder that the benign scenarios exposed, and the golden-set harness
itself. As with the other reference documents, this goes file by file — what the
code does, how it works, and why it is written that way.

---

## 1. The gap this closes

Before this work, every window the system had ever classified was a genuine
incident. All three generator scenarios — `error-spike`, `latency-jump`,
`new-error` — are real bugs.

That means the half of Tier 2's job that justifies its existence had never been
exercised. The classifier's system prompt spends four bullet points on it:

> A deploy restart, a scheduled batch job, a load test and a dependency's
> planned maintenance all produce the same statistical shape as an outage. The
> numbers cannot tell them apart. The log text usually can.

Nothing verified that claim. The system could have been dismissing nothing, or
dismissing everything, and no test would have noticed. Worse, the demo could not
*show* a dismissal, which is the one behaviour that distinguishes this project
from a threshold alert with a language model bolted on.

Two things were needed: windows that should be dismissed, and a way to score
whether they are.

---

## 2. Files

```
packages/generator/src/
  scenarios.ts          + benign flag, progress phases, narration and
                          scenario-owned requests, three new scenarios
  index.ts              + progress passthrough, minute-aligned injections,
                          scenario table in --help

packages/backend/src/classification/
  context.ts            + sampleDiverse, per-minute timeline, per-endpoint
                          breakdown, larger healthy budget
  context.test.ts       + 10 tests over sampling, narration, timeline, endpoints
  classify.ts           + renderContextForAnomaly, loadTimeline,
                          loadEndpointMetrics, equalised scan caps

packages/backend/src/eval/
  cases.ts              Golden case schema, loading, saving
  grounding.ts          Is affectedArea supported by the evidence?
  score.ts              Bands, per-case scoring, split summary
  run.ts                Runs the set through a provider
  cli.ts                pnpm eval
  score.test.ts         14 tests over grounding and scoring
  cases/*.json          Six captured cases

scripts/
  capture-cases.sh      Rebuilds the golden set from real runs. Needed
                        whenever the evidence packet changes.
```

---

## 3. Generator: scenarios that should be dismissed

### 3.1 The interface, and why it grew

A scenario was previously a description, a profile transform, and an optional
error kind:

```ts
export interface Scenario {
  readonly description: string;
  readonly profile: (base: TrafficProfile) => TrafficProfile;
  readonly error?: FailureKind;
}
```

That is enough to express "things are bad". It cannot express either of the two
things that make a window benign, so it gained three fields:

```ts
export interface Scenario {
  readonly description: string;
  /**
   * True when a correct classifier should dismiss this window as benign.
   *
   * Every one of these still trips Tier 1 — that is the point.
   */
  readonly benign: boolean;
  /**
   * `progress` is the position within the injection window, 0 at its start and
   * approaching 1 at its end. It exists so a scenario can have phases.
   */
  readonly profile: (base: TrafficProfile, progress: number) => TrafficProfile;
  readonly error?: FailureKind;
  /** Lines that say what is happening, emitted once per generated window. */
  readonly context?: (
    windowStart: Date,
    rng: Rng,
    progress: number,
  ) => readonly ContextLine[];
}
```

**`benign`** is metadata, not behaviour. The CLI prints it, and it documents the
scenario's intent at the point of definition rather than in a table somewhere
else that can drift.

**`progress`** buys phases. A profile that is constant across the injection can
only describe a steady state, and an incident that *recovers* is the single
clearest benign signal there is — a five-minute window where errors stop after
minute one tells a completely different story from one where they do not. The
three original scenarios ignore the argument entirely, which is why adding it
was safe.

**`context`** buys narration, and it is the load-bearing part. This deserves
more than a sentence, so it gets §3.3.

### 3.2 The three scenarios

**`deploy-restart`** — the canonical false positive.

```ts
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
```

`RESTART_PHASE` is `0.2`, so on a five-minute injection the burst occupies
minute one and the remaining four minutes are ordinary healthy traffic. The
profile returns `base` unchanged after that — literal recovery, not a tapering
curve.

This is the sharpest case in the set. In the captured run it fires
`error_rate_spike` at z=28.8 and `new_error_signature` on a signature seen 117
times — *the same pair* the null-price bug fires, at comparable magnitudes. A
detector cannot separate them. A reader can, in about two seconds, because one
of them says `v1.4.2 starting up`.

**`batch-job`** — a trigger firing correctly on something that does not matter.

> The first version of this scenario multiplied *every* request's latency by
> eight. That made it an incident wearing a benign label, and the Gemini run
> caught it — see [§8](#8-the-gemini-run-and-what-it-exposed). What follows is
> the corrected version.

```ts
"batch-job": {
  benign: true,
  // User traffic is deliberately untouched — the job's own work is emitted below.
  profile: (base) => base,
  context: (_windowStart, rng, progress) => {
    const lines: ContextLine[] = [ /* narration */ ];

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
    // ...plus its 409 skip warnings, on the same path.
    return lines;
  },
}
```

The 409 matters. The ingestion contract maps status codes below 500 to `warn`,
and `ERROR_LEVELS` is `["error", "fatal"]`, so these never reach the error-rate
detector. What they *do* reach is the signature detector, because
`SIGNATURE_LEVELS` deliberately includes `warn`. The result is a window firing
`latency_jump` and `new_error_signature` with a literal zero error count — a
demonstration that a trigger firing and something being wrong are different
claims.

The randomised record id is not decoration. It exercises signature
normalisation: in the captured case 68 occurrences, almost all with distinct
ids, collapse to the single signature `Record <num> already processed,
skipping`. Without that collapsing the detector would report dozens of novel
signatures instead of one.

**`rate-limit-storm`** — a protection mechanism working as designed.

> Also corrected after the Gemini run: the first version slowed every request
> six-fold, which made "other clients unaffected" a claim the data flatly
> contradicted. See [§8](#8-the-gemini-run-and-what-it-exposed).

```ts
"rate-limit-storm": {
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
    ...
  },
  context: () => [{
    level: "warn",
    message: "Client 4471 exceeded quota: 12000 requests in 60s, throttling that client only",
  }],
}
```

The fixed client id is the interesting detail. The baseline already emits
`Rate limit exceeded for client N` with random ids, and normalisation collapses
both to the same signature — so the flood is invisible to the new-signature
detector and registers only as volume.

After the fix this is the quietest case in the set: nothing slows down, 429s are
warnings rather than errors, and the **only** detector that fires is the
new-signature one, on the quota warning itself. That makes it a clean test of a
single question — a brand-new warning appeared and it describes a protection
working exactly as designed; is that an incident?

It is also the subtlest, because something genuinely *is* being refused. Whether
it should be dismissed is a real judgement rather than an obvious one, which is
exactly the kind of case a golden set should contain.

### 3.3 Narration, and why it is load-bearing

Without `context`, the benign scenarios would be unsolvable. Consider what a
classifier actually sees for `deploy-restart` with narration stripped: a burst
of 503s from a novel signature, at 40x the baseline error rate, on a service
whose endpoints are all failing. There is no reading of that evidence which
supports "benign". A model that dismissed it would be guessing, and an eval that
rewarded the guess would be measuring luck.

With narration, the window contains `orders-api v1.4.2 starting up` and
`Rollout complete: 3 of 3 instances healthy` — and the errors visibly stop after
minute one. Now the correct answer is derivable from the evidence, which is the
minimum bar for a fair test.

The emission is deliberately plain:

```ts
for (const line of scenario?.context?.(windowStart, rng, progress) ?? []) {
  entries.push({
    timestamp: new Date(windowStart.getTime() + (line.offsetMs ?? 0)),
    service: effective.service,
    level: line.level,
    message: line.message,
    metadata: {},
  });
}
```

The empty `metadata` is meaningful rather than lazy. Request logs in this system
always carry `endpoint` and `statusCode`; narration describes the *service*, not
a request, and has neither. That distinction survives into the rendered prompt,
where these lines appear without an endpoint column — visibly a different kind
of statement.

### 3.4 Minute alignment

A bug found while capturing, and a good example of two correct components
disagreeing at a boundary.

Rollup buckets are minute-aligned. Detection windows are minute-aligned, being
derived from bucket boundaries. Generated traffic was aligned to *whenever the
command happened to run*:

```ts
const now = Date.now();
const startMs = now - options.minutes * 60_000;
```

Run at 17:49:58.123, a five-minute injection covers 17:49:58.123 → 17:54:58.123,
while the detection window covers 17:50:00 → 17:55:00. The first 1.9 seconds of
the injection fall outside the window that injection exists to create.

Usually harmless — a couple of seconds of traffic among thousands of lines. Not
harmless when a scenario emits exactly one line at offset zero, which is how the
deploy banner ended up outside the window it explains. The fix:

```ts
/**
 * Ends at the last minute boundary rather than at `now`.
 * ...Aligning here makes an injection land on exactly the minutes it claims to.
 */
const endMs = Math.floor(Date.now() / 60_000) * 60_000;
const startMs = endMs - options.minutes * 60_000;
```

A secondary benefit: injections are now reproducible relative to bucket
boundaries. Previously the same seed produced a different bucket distribution
depending on which second you ran it, which quietly undermined the project's
claim that seeded generation makes the demo tell the same story every run.

---

## 4. Two fixes to the evidence builder

Both were in code that passed its tests. Neither was reachable while every test
case was an unambiguous incident, because in an incident window the important
lines are also the *common* ones.

### 4.1 Uniform sampling dropped the only line that mattered

The original sampler spread its budget evenly across time:

```ts
const sampled = [
  ...sampleEvenly(errorLines, contextBudget.maxErrorLines),
  ...sampleEvenly(healthyLines, contextBudget.maxHealthyLines),
];
```

`sampleEvenly` is good at what it does — it shows an incident's arc rather than
its first minute. But it treats every line as equally informative, and in a log
stream that is badly false. The first captured `deploy-restart` case proved it:
five healthy slots, drawn evenly from roughly two thousand `GET /orders 200`
lines and one deploy banner. The banner had a 1-in-400 chance per slot. It did
not survive, and the captured case was a benign window that no reader could have
judged correctly.

The fix generalises the observation rather than special-casing banners:

> A log line is informative roughly in proportion to how rare its shape is.

```ts
export function sampleDiverse<T>(
  items: readonly T[],
  limit: number,
  shapeOf: (item: T) => string,
): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const shape = shapeOf(item);
    const group = groups.get(shape);
    if (group) group.push(item);
    else groups.set(shape, [item]);
  }

  // Rarest shapes first, so a one-off line is never the one that gets cut.
  const ordered = [...groups.values()].sort((a, b) => a.length - b.length);

  const take = new Array<number>(ordered.length).fill(0);
  let remaining = limit;

  while (remaining > 0) {
    let allocated = false;
    for (let i = 0; i < ordered.length && remaining > 0; i += 1) {
      const group = ordered[i];
      if (group && take[i]! < group.length) {
        take[i]! += 1;
        remaining -= 1;
        allocated = true;
      }
    }
    // Every group is exhausted; the budget was larger than the input.
    if (!allocated) break;
  }

  // Even spacing within each shape, so a shape's own progression still shows.
  return ordered.flatMap((group, i) => sampleEvenly(group, take[i] ?? 0));
}
```

Walking the allocation: `take[]` starts at zero for every shape. Each pass of the
`while` loop offers one slot to each shape in rarest-first order, skipping any
shape already exhausted. So every shape receives its first slot before any shape
receives a second — the guarantee that a one-off line survives — and once the
small groups run out, the remaining passes fall through to the common shapes, so
the budget is always spent in full. The `allocated` flag terminates the loop when
no group can take more, which is the case where the caller asked for more lines
than exist.

The final `flatMap` calls `sampleEvenly` **within** each group, so both
properties hold at once: diversity across shapes, and temporal spread within a
shape. The 503 burst still shows its arc; the banner still gets its slot.

The shape key:

```ts
const shapeOf = (line: ContextLogLine): string =>
  `${line.endpoint ?? ""} ${line.statusCode ?? ""} ${normalizeErrorSignature(line.message)}`;
```

Reusing `normalizeErrorSignature` — the same function the error signatures use —
means `Order 12778 not found` and `Order 44012 not found` are one shape, for free
and consistently with the rest of the system. Endpoint and status join the key
because `GET /orders 200` and `POST /orders 201` share a message template while
being genuinely different events.

**An earlier attempt was wrong, and instructively so.** The first version
allocated a fixed `perGroup = floor(limit / groups)` and then ran a fill pass
guarded by `!picked.includes(item)`. That fails on duplicate primitives — every
routine line is the identical string, so `includes` reported them all as already
picked and the fill pass added nothing, returning 3 items for a limit of 5. It
happened to work on objects, which is the real call site, and would have shipped
undetected if the test had used log lines rather than plain strings. The
round-robin version has no identity check at all, because it allocates counts
rather than filtering values.

### 4.2 The scan cap hid the second half of the window

Loading was capped asymmetrically:

```ts
const MAX_ERROR_ROWS_SCANNED = 2000;
const MAX_HEALTHY_ROWS_SCANNED = 200;
```

On the same assumption — routine traffic is interchangeable, so a couple of
hundred is plenty. The query orders by timestamp ascending, so a 200-row cap on
a service handling 240 requests a minute covers **the first twenty-five
seconds** of a five-minute window and discards everything after.

That silently deleted every announcement made later in the window, including
`Rollout complete: 3 of 3 instances healthy` — the line stating the incident was
over. The classifier was being asked to judge whether a window had recovered,
with the recovery notice removed from its evidence.

The caps are now equal at 2000, and the comment records why so nobody
"optimises" it back:

```ts
/**
 * The caps are equal for a reason learned the hard way. Healthy rows were
 * originally capped an order of magnitude lower, on the assumption that
 * routine traffic is interchangeable and a handful is as good as a thousand.
 * It is not: service narration — deploy banners, "rollout complete", batch job
 * start and finish lines — is info-level, and those are the lines that explain
 * a window.
 */
```

The healthy *budget* rose too, from 5 rendered lines to 8, since those slots now
carry narration as well as contrast, and under the new sampler narration always
wins them.

---

## 5. The eval module

### 5.1 `cases.ts` — captured, not written

```ts
export const goldenCaseSchema = z.object({
  name: z.string().min(1),
  scenario: z.string().min(1),
  capturedAt: z.string(),
  expect: z.object({
    isRealIncident: z.boolean(),
    severity: severitySchema,
    note: z.string(),
  }),
  context: z.string().min(1),
});
```

`context` is the **entire rendered prompt**, stored as a string. That is the
central design decision of the harness.

The alternative — storing a structured `ClassificationInput` and re-rendering it
at eval time — was rejected because it measures the wrong thing. If the renderer
changes, re-rendered fixtures change silently with it, and the eval keeps
reporting on whatever the renderer does today. A stored string is a fixed
artefact: it is exactly what some real run produced, and comparing scores across
prompt versions means something.

The cost is honest and stated: when the context builder changes, cases must be
re-captured. That happened twice during this work.

Cases are validated on load rather than trusted:

```ts
if (!parsed.success) {
  // A malformed case would silently skew the score. Fail loudly instead.
  throw new Error(`Golden case ${file} is invalid:\n...`);
}
```

A case missing `isRealIncident` would otherwise score as `undefined !== true` —
a silent wrong answer against the model, which is the worst failure mode a
benchmark can have.

### 5.2 `grounding.ts` — a hallucination check with no judgement in it

This file exists because of one observed failure. Asked to classify a window
whose endpoints were `/orders`, `/orders/:id` and `/orders/:id/refund`, llama3.2
answered `affectedArea: "/orders/checkout path"`. Verdict right, severity right,
and the one field naming *where* fabricated out of nothing.

The prompt explicitly offers `"unknown"` for this case. So the question worth
measuring is whether a model takes that option or fills the space — and that is
mechanically checkable.

```ts
const area = affectedArea.trim().toLowerCase();
const haystack = context.toLowerCase();

if (area === "" || area === "unknown" || area === "n/a") {
  return { grounded: true, reason: "declined to name an area" };
}
```

**Declining counts as grounded.** A model that says "unknown" when the evidence
is thin is doing precisely what it was told, and scoring that as a failure would
push the prompt in exactly the wrong direction — toward confident guessing.

```ts
const paths = (area.match(PATH_PATTERN) ?? []).map((p) => p.replace(/[.,;:]+$/, ""));

if (paths.length > 0) {
  const missing = paths.filter((path) => !haystack.includes(path));
  return missing.length === 0
    ? { grounded: true, reason: `path ${paths.join(", ")} appears in the evidence` }
    : { grounded: false, reason: `path ${missing.join(", ")} appears nowhere in the evidence` };
}
```

A path is the highest-signal thing an area can name and the easiest to
fabricate, so when one is present it is checked strictly — every path must appear
verbatim in what the model was shown. Trailing punctuation is stripped because
`/orders/:id` and `/orders/:id.` are the same claim.

Otherwise it falls back to vocabulary overlap:

```ts
const words = area.split(/[^a-z0-9]+/).filter((word) => word.length >= MIN_WORD_LENGTH);
const present = words.filter((word) => haystack.includes(word));
const ratio = present.length / words.length;
return ratio >= WORD_OVERLAP_THRESHOLD ? ... : ...;
```

So `postgres connection pool` is grounded if the evidence discusses those things,
and `kafka consumer lag on billing` is not. Words shorter than four characters
are dropped because "the" and "pool" carry very different evidential weight.

The whole check is deliberately dumb. The alternative — an LLM judge — means a
model grading a model, which is unfalsifiable in exactly the way this project
tries to avoid.

### 5.3 `score.ts` — the split that makes the result readable

```ts
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

export function severityDistance(a: Severity, b: Severity): number {
  return Math.abs(SEVERITY_RANK[a] - SEVERITY_RANK[b]);
}
```

Severity is scored **within one band**, with exact match reported but not
headlined. The boundary between `high` and `critical` is a matter of taste; the
boundary between `low` and `critical` is not. Demanding exact agreement would be
scoring agreement with one labeller's judgement rather than competence.

The summary's most important property is that verdict accuracy is reported
twice:

```ts
dismissals: {
  correct: count(benign, (score) => score.verdictCorrect),
  total: benign.length,
},
incidents: {
  correct: count(incidents, (score) => score.verdictCorrect),
  total: incidents.length,
},
```

A model that answers "critical incident" to everything scores **100% on the
incident half**. Blended into one number with three benign cases it reads as
50% — mediocre, but not obviously pathological. Split, it reads as 3/3 and 0/3,
which is instantly diagnostic: the model is not judging, it is defaulting.

That is not a hypothetical designed-for case. It is what the first run found.

Failed calls are counted separately from wrong answers, for the same reason:
quota exhaustion and bad judgement are different problems and must not average
together.

### 5.4 `run.ts` — measuring the pipeline, not a reconstruction

```ts
const { value, stats } = await generateStructured({
  provider,
  schema: classificationSchema,
  system: CLASSIFIER_SYSTEM_PROMPT,
  user: golden.context,
  agent: "classifier",
});
```

Every case goes through the real `generateStructured`, so the repair loop is part
of what is measured — a model needing two repairs to produce the schema is worse
than one needing none, and the scorecard reports repairs alongside accuracy.

One deliberate omission: **no `onCall` sink**, so eval calls are never written to
`llm_calls`.

```
 * Eval calls are **not** written to `llm_calls`. That table is the accounting
 * behind a claim about what running the system costs; filling it with calls
 * that classified no anomaly would inflate exactly the number it exists to
 * substantiate.
```

The eval reports its own spend instead, from the returned `stats`.

### 5.5 `cli.ts` — and the capture workflow

Capture is what makes the golden set cheap to extend:

```bash
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm detect
pnpm eval --capture deploy-restart --scenario deploy-restart \
          --expect benign --severity low --note "recovered within a minute"
```

`--capture` calls `renderContextForAnomaly()` with no id, which defaults to the
most recently detected anomaly — that default is what removes the id-copying step
between commands. It writes the rendered packet plus the label to
`src/eval/cases/<name>.json`.

The remaining flags are worth knowing:

| Flag | Use |
|---|---|
| `--provider <name>` | Score a different provider without touching `.env` |
| `--case <name>` | One case, for iterating on a single failure |
| `--list` | The set and its labels |
| `--show <name>` | The exact evidence packet — the first thing to read when a score looks wrong |

The process exits non-zero when any verdict is wrong. `pnpm eval` therefore
currently fails, which is correct: it is a failing benchmark, and a benchmark
that exits 0 while reporting 0/3 would be lying by omission.

---

## 6. Tests added

Twenty new unit tests, none of which need a network or a database.

**Shape sampling** (`context.test.ts`) — the important one restates the original
bug as an assertion:

```ts
it("keeps a one-off line that uniform sampling would drown", () => {
  // The deploy-restart failure: one banner among two thousand routine lines.
  const lines = [...Array.from({ length: 2000 }, () => "GET /orders 200"), "v1.4.2 starting up"];

  expect(sampleDiverse(lines, 5, shape)).toContain("v1.4.2 starting up");
});
```

Plus: the budget is still spent in full, rare shapes get a fair share against
common ones, the limit is never exceeded however many shapes exist, and — at the
render level — a deploy banner among five hundred routine info lines survives
into the output.

**Grounding** (`score.test.ts`) — the observed failure, verbatim:

```ts
it("rejects a path that appears nowhere — the observed failure", () => {
  // llama3.2 answered this for a service whose endpoints are /orders,
  // /orders/:id and /orders/:id/refund. Verdict right, location invented.
  const result = checkGrounding("/orders/checkout path", CONTEXT);

  expect(result.grounded).toBe(false);
  expect(result.reason).toContain("/orders/checkout");
});
```

Plus: declining is grounded, prose overlap works both ways, trailing punctuation
is ignored.

**Scoring** — severity bands, the benign-called-incident case, and the summary
split reporting dismissals and confirmations separately.

---

## 7. What it found — the small-model runs

```
                             stub    llama3.2 (3.2B)
dismissed benign windows     0/3     0/3
confirmed real incidents     2/3     3/3
severity within one band     2/6     3/6
area grounded in evidence    6/6     5/6
cost                          —      7701 in / 284 out, 0 repairs, mean 7965ms
```

The stub is the control. It scores by counting which detectors fired, so it *is*
the statistical judgement with no reading involved, and 0/3 on dismissals is the
expected and necessary result — if the stub could dismiss benign windows, Tier 2
would have no reason to exist.

llama3.2 returned `critical` and `isRealIncident: true` for **all six cases**,
including a rolling restart that recovered inside the window with two log lines
saying so. Its 3/3 on incidents is therefore an artefact of always answering the
same thing, not evidence of judgement — which is exactly the failure the split
scorecard was built to expose. It also reproduced the grounding failure, on a
different case from the one that motivated the check.

**The honest reading:** on available evidence, Tier 2 adds nothing over Tier 1 on
the judgement it exists to make.

A 3B model is far below what the design assumes — Gemini 2.5 Flash is the
intended default and is free — so the likely explanation is model capability
rather than a broken prompt. But that is a hypothesis, and the point of building
this was to stop accepting hypotheses.

**What was deliberately not done:** tuning the prompt until the numbers improve.
Six cases and a 3B model is nowhere near enough signal to justify prompt changes,
and a prompt fitted to this set would score well on this set and mean nothing.
The next step is a run against a capable model, not a rewrite.

---

## 8. The Gemini run, and what it exposed

Running the set against Gemini 2.5 Flash — the model the design actually assumes
— produced a much better result and, more usefully, showed that **two of the six
cases were mislabelled**. The eval tested the labels as much as the model.

```
                             stub    llama3.2    gemini-2.5-flash
dismissed benign windows     0/3     0/3         1/3
confirmed real incidents     2/3     3/3         3/3
severity within one band     2/6     3/6         6/6   (exact 3/6)
area grounded in evidence    6/6     5/6         6/6
repairs                       —      0           0
```

Severity calibration went from 2/6 to 6/6 within a band, grounding was perfect,
and the schema held on every call with zero repairs. It also dismissed
`deploy-restart` — the flagship case, statistically indistinguishable from the
null-price bug — which no earlier configuration had managed.

### The two failures were my fault

`batch-job` and `rate-limit-storm` came back as real incidents at *medium*
severity. Inspecting the evidence rather than the verdict showed why:

| Case | p50 | p95 | vs baseline (45 / 169 ms) |
|---|---|---|---|
| `deploy-restart` | 51 ms | 186 ms | normal |
| `batch-job` | 178 ms | 1369 ms | 4× / 8× |
| `rate-limit-storm` | 242 ms | 988 ms | 5× / 6× |

Both "benign" scenarios were built by multiplying **every request's** latency by
six to eight — which is exactly how the `latency-jump` *incident* is built
(median × 8). They were the same degradation with a friendlier log line attached.
The narration claimed the impact was contained (*"throttling that client only"*)
while the metrics showed every user waiting a second or more.

Calling that a real incident is defensible. Arguably more defensible than the
label. And the model was not saturating — it said medium, not critical, and got
all three genuine incidents right at high.

**The lesson, which generalises beyond this project:** you cannot make a window
benign by narrating it. If the numbers still show users suffering, it is an
incident regardless of the cause. A benign scenario has to *contain the impact*,
not explain it away.

### The fix: contain the impact

`ContextLine` gained request fields (`endpoint`, `statusCode`, `latencyMs`), so a
scenario can emit work of its own rather than only narration.

**`batch-job`** now leaves user traffic completely untouched and emits 45 slow
chunks a minute on `/internal/reconcile`. The service-wide p95 still explodes —
the latency detector still fires — but p50 barely moves, because the slow
requests are all the job's own. That bimodal shape is the real signature of a
background workload polluting a shared metric.

**`rate-limit-storm`** keeps the 4× volume and the 429s but leaves latency alone,
because rejecting a request is cheap — that is the entire point of a rate
limiter. After the fix it fires **only** the new-signature detector, on the quota
warning itself, making it a clean test of one question: a brand-new warning
appeared and it describes a protection working as designed; is that an incident?

Captured evidence after the fix, which now matches the story:

```
batch-job          p50 51ms | p95 2925ms
  /internal/reconcile    285 req    0 err   p95 6536ms
  /orders               1177 req    6 err   p95  177ms
  /orders/:id           1151 req    4 err   p95   80ms
```

---

## 9. Two additions to the evidence packet, and an A/B

### Per-endpoint latency

The breakdown above did not exist before this work. The rollup worker had always
written per-endpoint rows; the classifier only ever read the service-wide
sentinel. Without it, "the service is slow" and "one background path is slow and
users are fine" are indistinguishable — identical aggregate p95, opposite
verdicts.

Adding it produced a surprise. Re-running the set scored **1/3 again, but on a
different case**: `rate-limit-storm` now passed and `deploy-restart` regressed.

Three consecutive runs of `deploy-restart` gave the same wrong answer, so this
was not temperature noise. A direct A/B — the same captured case with one section
deleted — isolated the cause:

| Case | With endpoint table | Without it |
|---|---|---|
| `deploy-restart` | incident / high ✗ (3 runs) | **dismissed / low ✓** (2 runs) |
| `batch-job` | incident / medium ✗ | incident / high ✗ (2 runs) |
| `rate-limit-storm` | **dismissed / low ✓** | incident / medium ✗ (2 runs) |

The table traded one case for another. Net zero, stable in both directions, and
**more evidence made one judgement worse** — which is worth stating plainly,
because the intuitive assumption is that context can only help.

### The diagnosis: no time axis

The endpoint table aggregates the whole window. `deploy-restart`'s errors are
confined to its first minute but spread across all three user paths, so the table
rendered them as sustained multi-endpoint failure — contradicting the recovery
that was visible only in the log lines.

Totals say *how much*. The endpoint breakdown says *where*. Neither says *when* —
and whether an incident is growing, steady, or already over is the most
decision-relevant thing about it.

### Per-minute detail

So the packet gained a timeline, built from the same rollup rows, kept in
sequence instead of collapsed:

```
Per-minute detail (5 minutes):
  18:57    437 req    101 err  p95   270ms
  18:58    505 req      3 err  p95   183ms
  18:59    479 req      2 err  p95   177ms
  19:00    413 req      1 err  p95   190ms
  19:01    426 req      4 err  p95   170ms
```

That is the fact the model was missing. When truncating a long merged window it
keeps the **tail**, because the recent minutes are the ones that say whether the
incident is still happening.

**First measured effect:** `batch-job` — a case that had failed in every previous
configuration, against all three providers, with and without the endpoint table —
came back `dismissed / medium`. Correct verdict, and the first time that case had
ever passed.

---

## 10. Where the measurement actually stands

**Incomplete, and worth being precise about.**

The final configuration — fixed scenarios, endpoint breakdown, per-minute
timeline — has exactly **one case measured**. The Gemini free tier allows 20
requests a day for 2.5 Flash, and the full run plus the A/B experiments consumed
them. Five of six cases returned HTTP 429 before being answered.

What is measured, and what is not:

| Configuration | Coverage | Result |
|---|---|---|
| stub | 6/6 | 0/3 dismissals |
| llama3.2 | 6/6 | 0/3 dismissals |
| Gemini, original scenarios | 6/6 | 1/3 dismissals, 6/6 severity, 6/6 grounded |
| Gemini, fixed scenarios + endpoints | 6/6 | 1/3 dismissals (different case) |
| **Gemini, + per-minute timeline** | **1/6** | `batch-job` ✓ — the rest unmeasured |

So the honest claim today is narrow: **Gemini clearly outperforms both the
statistical baseline and a 3B model on severity calibration, grounding and
schema compliance, and dismisses at least one benign window the statistics
cannot.** Whether the final packet gets the remaining cases right is a run away,
not a conclusion.

The eval reports this correctly rather than hiding it. Failed calls are counted
separately from wrong answers — a design decision made before it mattered,
precisely so quota exhaustion could never be confused with bad judgement.

**Operational note worth keeping:** 20 requests a day makes the eval a
once-or-twice-daily instrument on the free tier, not something to run in a loop.
It also retroactively justifies the `--limit 10` cap on `pnpm classify`: a
backlog genuinely could drain a day's quota in a single run.

### On the risk of tuning

Three changes were made across these runs. Only one was a response to a wrong
answer, and the distinction matters:

- **The scenario fix** — legitimate. The data contradicted the label; the test
  was wrong, independently of what any model said.
- **The endpoint breakdown** — legitimate. Evidence the system already collected
  and had never surfaced, addressing a real gap.
- **The per-minute timeline** — the borderline one. It was prompted by a wrong
  answer, but the diagnosis was specific and mechanical (the packet had no time
  axis at all), and the fix serves every case rather than the one that failed.

What was *not* done, at any point: relabelling a case so the score improved, or
editing the prompt to chase a number. On six cases either would produce a
harness that measures its own tuning.

---

## 11. Trade-offs

| Decision | Buys | Costs |
|---|---|---|
| **Cases captured, not authored** | Measures the prompt the system really sends | Re-capture needed whenever the context builder changes |
| **Whole prompt stored as a string** | Scores are comparable across prompt versions | Cases are opaque blobs; `--show` exists for this |
| **Sample by shape, not uniformly** | A one-off line is never crowded out | Under-represents how dominant common shapes are; signature counts carry that |
| **Severity within one band** | Not scoring one labeller's taste | A consistently-one-band-high model looks perfect |
| **Grounding by string matching** | Mechanical, no LLM judge, no unfalsifiable metric | Misses a *plausible* invention that reuses evidence vocabulary |
| **Summary wording unscored** | No metric that cannot be trusted | The most human-visible output is unmeasured |
| **Eval calls excluded from `llm_calls`** | Cost table stays an honest record of incident spend | Eval spend readable only from eval output |
| **Non-zero exit on any wrong verdict** | A failing benchmark reports failure | `pnpm eval` fails today, and will until a capable model runs it |

---

## 12. Limitations

**Six cases is a small set.** Enough to catch a model that defaults to one
answer; nowhere near enough to rank two competent models against each other, and
far too small to tune a prompt against.

**One service, one shape of application.** Every case is `orders-api`. Nothing
tests cross-service reasoning, and nothing tests a domain whose logs look
different.

**Benign cases are the ones a system can construct.** A deploy, a batch job and a
rate limiter are the easy benign windows — each announces itself in text. The
hard ones do not: a traffic shift after a marketing email, a dependency degrading
within its SLA, a client retrying badly. Those have no narration to read, and the
set does not contain one.

**Labels are one person's judgement.** `rate-limit-storm` in particular is
genuinely arguable — something *is* being refused. The `note` field on each case
records the reasoning so a disagreement is with a stated argument rather than a
bare boolean.

**No regression tracking.** Scores are printed, not stored. Comparing runs across
prompt versions means keeping the output yourself. A results table written to the
database would be the natural next increment, and would make "accuracy across
prompt versions" — the thing the architecture document actually asks for — a
query rather than a scrollback search.

---

## 13. Adding to the set

A new benign scenario:

1. Add it to `SCENARIO_NAMES` and `SCENARIOS` in `packages/generator/src/scenarios.ts`
   with `benign: true`.
2. Give it narration via `context` — without it the case is unsolvable and the
   eval measures luck.
3. Verify it trips Tier 1. If `pnpm detect` reports `clean`, the scenario tests
   nothing, because the window never reaches the classifier.
4. Capture and label it, with a `note` that argues for the label.

A new case from a *real* incident, if this is ever pointed at a real system, is
the same flow minus the generator: detect, then `pnpm eval --capture`. The
harness has no dependency on synthetic data — it captures whatever the pipeline
produced.
