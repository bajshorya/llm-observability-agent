# Evaluation Harness — Full Reference

Phase 2 built a classifier and argued that it can tell a deploy restart from an
outage. This work tests that argument.

The short version: **it holds.** A capable model separates three benign windows
from three real incidents that are statistically indistinguishable, scoring 6/6
on every measure, while the statistical baseline scores 0/3 on the benign half.
Getting there took two runs that said otherwise, and finding that two of the six
labels were wrong — which is the more useful half of the story and is kept here
in full.

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

## 10. Where the measurement stands

**The claim holds.** On `gemini-3.5-flash` the golden set scores a clean sweep,
identical across two consecutive runs:

```
  dismissed benign windows   3/3  (100%)
  confirmed real incidents   3/3  (100%)
  severity within one band   6/6  (exact 6/6)
  area grounded in evidence  6/6  (100%)
  cost                       13199 in / 546 out, 2 repair(s), mean 22s
```

Set against the control, that is the whole argument of the project in one table:

```
                             stub    llama3.2   gemini-2.5-flash   gemini-3.5-flash
dismissed benign windows     0/3     0/3        1/3                3/3
confirmed real incidents     2/3     3/3        3/3                3/3
severity within one band     2/6     3/6        6/6                6/6 (exact 6/6)
area grounded in evidence    6/6     5/6        6/6                6/6
```

The stub scores by counting which detectors fired — it **is** the statistical
judgement, with no reading involved — and it dismisses nothing, because the three
benign windows are statistically indistinguishable from the three incidents. That
is not a weakness of the stub; it is the reason Tier 2 exists, and 0/3 is the
number that makes the claim falsifiable in the first place.

A capable model dismisses all three. The gap between those two rows is exactly
the value the LLM tier adds, measured rather than asserted.

### What the repairs prove

Every run reports **2 repair attempts**. Twice per set, the model returns
something that fails Zod validation and the repair loop feeds it back its own
output plus the specific errors — and both times it recovers, because no case
ever fails with "no valid answer".

That is the loop earning its place. Without it those two cases would be errors
rather than results, and the score would read 4/6 with two failures that had
nothing to do with judgement.

### The cost of being right

`gemini-3.5-flash` is roughly five times slower than `gemini-2.5-flash` — about
22 seconds a call against 5. For a stage that runs on anomalies rather than in a
request path this is a good trade, and it is the reason the model is a
configuration value rather than a constant.

### What is still not measured

- **One provider.** NVIDIA, OpenRouter and Ollama remain untested against the
  final packet; only the stub and llama3.2 have historical numbers, both against
  an older version of the evidence.
- **Six cases.** Enough to catch a model that defaults to one answer, and now
  enough to show a capable model separating the two halves. Not enough to rank
  two competent models against each other.
- **The easy benign windows.** All three announce themselves in text. A traffic
  shift after a marketing email, or a dependency degrading inside its SLA, has no
  narration to read — see [§12](#12-limitations).

### On the risk of tuning

Three changes were made across these runs, and the distinction between them is
what keeps the result meaningful:

- **The scenario fix** — legitimate. The data contradicted the label; the test
  was wrong independently of what any model said.
- **The endpoint breakdown** — legitimate. Evidence the system already collected
  and had never surfaced.
- **The per-minute timeline** — the borderline one. Prompted by a wrong answer,
  but the diagnosis was mechanical (the packet had no time axis at all) and the
  fix serves every case rather than the one that failed.

What was never done: relabelling a case so the score improved, or editing the
prompt to chase a number. The prompt is byte-for-byte what it was before the
first Gemini run. Everything that changed was evidence or test data, and each
change is defensible without reference to the score it produced.

### An operational note

The free tier allows 20 requests a day **per model**. A six-case run plus any
experimentation exhausts one model's budget, which is what makes the eval a
once-or-twice-daily instrument rather than something to run in a loop. It also
retroactively justifies the `--limit 10` cap on `pnpm classify`: a backlog
genuinely could drain a day's quota in a single run.

Quota is bucketed per model, so `LLM_MODEL` is the way through a 429 when one
model is exhausted — which is how these final numbers were obtained.

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

---

## 14. The correlation eval, and its first result

Sections 1–13 measure **Tier 2 only**. This one measures Phase 3.

### The set is six cases, and why it is shaped that way

Only incidents reach correlation — Tier 2 dismisses benign windows and
`loadPending` filters on `is_real_incident = 1` — so the correlation set cannot
reuse the classifier's benign half. It is built from incident scenarios where
the right answer differs:

| Case | Expected | Why |
|---|---|---|
| `new-error` | the pricing commit | A novel `TypeError` on `toFixed`; that commit added the call, on a field that is null whenever no promotion applies |
| `limiter-misconfig` | the token-bucket commit | Legitimate writes rejected at quota across hundreds of clients; that commit introduced the limiter running the burst and refill the warning reports |
| `error-spike` | **null** | 40× volume of failures already in the baseline — an upstream dependency |
| `latency-jump` | **null** | p95 ×8 with no new signature — the same dependency, degrading |
| `traffic-surge` | **null** | volume ×5 saturating a pool sized in the initial scaffold; the load changed and the code did not |
| `orphan-refund-bug` | **null** | a novel error whose cause is nine days old and outside the lookback, so no candidate explains it |

**The four decline cases are four different reasons to answer null**, and that
is the point of the last two. `error-spike` and `latency-jump` both bottom out
at "an upstream dependency is failing" — a decline half where every case means
the same thing measures one thing twice.

`orphan-refund-bug` is the hardest of them. A novel error signature is the
strongest single signal that *code changed*, and the prompt says so. Here that
signal is true and the responsible change is simply not on offer, so the model
has to resist "a novel error appeared, therefore one of these commits did it".

**Two attributable cases pointing at DIFFERENT commits is the load-bearing
detail.** With one, "finds the guilty commit" and "has learned the answer is the
pricing one" produce identical scores. `limiter-misconfig` was added to the
generator for this reason, and it is the only scenario whose primary job is
correlation rather than classification.

**Every decline case is offered six candidates.** A decline scored against an
empty candidate list would measure nothing.

### The scorecard splits four ways

| Axis | Question |
|---|---|
| named the right commit | of the cases where one is responsible, how many were right |
| declined when it should | of the cases where none is, how many said so |
| right files within it | scored only on correctly attributed cases |
| confidence | mean when right, versus mean when wrong |

The first two are **never averaged**, for the reason §7 already found the hard
way. A model that names the newest commit every time scores 100% and 0%; one
that always declines scores the reverse. Blended, both read as "about half" —
indistinguishable from a model that is genuinely half right, and each is a
completely different failure.

Files are scored only where they can mean something. Inside a wrong commit they
are already counted by the attribution axis, and counting them twice would make
this axis a noisy echo of that one. The check is a **subset**, not an exact
match: naming an extra file the commit really touched is breadth, not error —
the same reasoning that scores severity within one band.

### The result

```
                            gemini-3.5-flash        stub (baseline)
  named the right commit    2/2   100%              0/2     0%
  declined when it should   1/2    50%              0/2     0%
  right files within it     2/2   100%              0/0    n/a
  confidence when right     0.92  when wrong 0.60   n/a    when wrong 0.25
  cost                      7028 in / 716 out, 0 repairs, mean 3307ms
```

**The baseline is 0/2 and 0/2.** It blames the newest commit, which the fixture
history is built so that it is never the answer — and it also names a commit on
both decline cases. That is the correlation-stage equivalent of the classifier
stub's 0/3 on the benign half: not a deficiency to fix, but the number that
makes the claim falsifiable.

**Attribution is 2/2 across two different commits**, so the model is not
pattern-matching one answer. It also named the right files inside both.

### The failure is the interesting half

`latency-jump` was attributed to the token-bucket commit at 0.60 confidence. Its
stated reasoning:

> Commit 8ef033668c introduced a per-client token bucket rate limiter on write
> paths … **If** the rate-limiting middleware uses a blocking or unoptimized
> storage mechanism (such as synchronous Redis calls or in-memory locks) to
> track token buckets, it can introduce severe latency bottlenecks…

There is no Redis anywhere in the evidence. The commit body **in the packet**
says the opposite — "Rejection is immediate and does no work, so a flooding
client cannot degrade latency for anyone else." The model invented an
implementation detail and reasoned from it: precisely the "mechanism, not a
coincidence" failure the prompt warns against, and a mechanism no reviewer could
check against the diff.

Re-running the case reproduced the same answer and the same confidence, so this
is stable behaviour rather than sampling noise.

**Two things about it are worth separating.** The confidence was *correctly*
lower — 0.60 against 0.92 on the cases it got right — so calibration is working;
the model knew this was weaker. What it did not do was decline. And the prompt's
own bands permit that: 0.5–0.8 is defined as "the mechanism is inferred rather
than visible in the evidence", which is an accurate description of what it did.

So the honest reading is that the model followed the prompt, and the prompt
allows naming a commit on an inferred mechanism. Whether it should — whether
that band ought to require a mechanism *visible in the evidence* — is a real
design question.

**It has deliberately not been changed.** Four cases is not enough signal to
justify a prompt edit, and a prompt rewritten against the run that exposed it
would score better on that run and mean nothing. This is the same rule that kept
the classifier prompt byte-for-byte unchanged through runs that scored badly.
The finding is recorded; the fix waits for evidence.

### Three models, and what that changed

The single-model result left one question open: is `latency-jump` a failure of
this model, or of the prompt? Running the same four cases against two more
models answers it — and no new test data was needed, which is why this was done
before adding cases.

```
                          gemini-3.5-flash  gemini-2.5-flash  llama3.2 (3B)  stub
  named the right commit       2/2               2/2              2/2         0/2
  declined when it should      1/2               1/2              0/2         0/2
  right files within it        2/2               2/2              2/2         0/0
  confidence when right       0.92              0.90             0.80         n/a
             when wrong       0.60              0.70             0.80        0.25
```

**Every model fails `latency-jump`, and they blame different commits.**
`gemini-3.5-flash` named the token-bucket commit; `gemini-2.5-flash` and
`llama3.2` named the pricing commit. Different culprits, same failure — so this
is not one model's quirk and not memorisation of a single answer. Something
about the case itself invites an answer.

**`error-spike` discriminates, so declining is not impossible.** Both Gemini
models decline correctly there. Whatever is wrong is specific to
`latency-jump`, not to the decline axis as a whole.

**Confidence separates the models sharply.** Both Geminis report lower
confidence when wrong — 0.60 and 0.70 against 0.90+ when right. `llama3.2`
reports 0.80 on all four answers, correct and incorrect alike. That is the same
pathology §7 found in classification, where it answered `critical` to
everything: a number that never varies carries no information, and a blended
scorecard would have hidden it behind a respectable 2/2 attribution.

**`llama3.2` also fabricated evidence.** Its reasoning on `error-spike` says
"the error text mentions an operation on the `discounted_total` field". It does
not. That string appears in exactly one place in the packet — the body of a
commit message — and the errors in that window are upstream payment timeouts.

That is worse than a wrong answer, because it is an unverifiable claim stated as
fact, and `grounding.ts` cannot catch it: the sha it named was real and the file
it named was in that commit. Grounding checks that the answer refers to things
the model was shown; it cannot check that the reasoning describes them
correctly. Doing so would need a model grading a model, which §12 rules out.

### Why `latency-jump` invites an answer, and where the fix belongs

The obvious response is to tighten the prompt — raise the bar for naming a
commit, or forbid the 0.5–0.8 band from being used to attribute. That would
probably fix this case. It is also the move `CLAUDE.md` forbids, and the
cross-model run shows why the instinct is wrong anyway: three models with very
different capabilities all fail identically, which points at the evidence rather
than the instructions.

Look at what the packet offers about the pricing commit:

```
  src/lib/pricing.js    +7/-1
  src/routes/orders.js  +2/-1
```

Two lines added to a route handler that serves the endpoints that got slow. The
model cannot tell whether those two lines are a string format or a synchronous
network round-trip, because the packet carries no diff content. Counts can
implicate a commit; they cannot **exonerate** one.

So the hypothesis was: add hunks. It is the change `CLAUDE.md` prescribes — fix
evidence, not the prompt — and it can be justified without reference to any
score.

### The A/B, and why it says not to

Hunks were built, and measured before being adopted. `renderCorrelationContext`
takes a `diffs` option, and `CAPTURE_CONTROL=1` stores both packet shapes **from
the same anomaly** — identical traffic, identical classifier summary, identical
candidates, differing only in the hunks. Capturing the arms from separate runs
would have confounded them with everything else that varies between runs, which
turned out to matter enormously.

```
                          no hunks (shipped)   with hunks
  gemini-3.5-flash             4/4                3/4
  gemini-2.5-flash             2/2 *              4/4
```
\* two cases hit the daily quota and are reported as failures, not wrong answers.

Three things came out of it, and the third is the important one.

**The diff cost one regression.** On `gemini-3.5-flash`, `limiter-misconfig` went
from correct to a decline. Its reasoning, having read the limiter's code: *"the
rate limiting behavior is working exactly as designed and configured … indicating
a genuine traffic surge or client-side behavior change rather than a bug."*

That is a defensible argument, and the diff is what enabled it: the limiter's
code **is** correct. The defect is in the constants it shipped with, not in the
logic, and a diff that shows correct logic argues for innocence. It did not
replicate on `gemini-2.5-flash`.

**It exposed a second evidence gap while we were looking at the first.** The
model reached for "a genuine traffic surge", and the packet cannot rule that out
— it carries the classifier's *summary* but none of its *numbers*, so request
volume is simply absent. Whether to add it is the same class of question, and it
is not being answered on this evidence either.

**The failure that motivated the whole change did not reproduce** — in either
arm, on either model. That is not the diff working. It is the next section.

### The cases are not stable across captures, and that is a real defect

`latency-jump` failed on three models in one capture and passes on two models in
the next, with the shipped packet unchanged between them. The difference is
upstream:

```
August capture    area: /orders endpoints
                  "latency degradation across multiple endpoints, particularly
                   affecting the refund and order creation paths"

September capture area: payments-service dependency
                  "a significant latency spike driven by upstream timeouts when
                   contacting payments-service"
```

A correlation packet embeds the **classifier's verdict**, and the classifier is
itself a model answering freshly generated traffic. When it names an external
cause, declining is nearly free; when it points at the order endpoints, the
correlator is invited to blame a commit that touches them. Same scenario, same
label, materially different difficulty.

The classifier set does not have this property — its cases embed only detector
output and log text, which are generated but not *reasoned*. Correlation is the
first stage whose golden cases inherit another model's judgement, and inheriting
it means inheriting its variance.

Consequences, stated plainly:

- Scores were comparable within a capture generation, not across them. The 1/2
  declining recorded earlier and the 2/2 after it were not the same
  measurement, and re-capturing could silently swap a hard case for an easy one.
- Four cases made this worse: one case changing difficulty moves the headline by
  25 points.

### The fix: pin the verdict

An eval measures one stage with its input held fixed. The classifier set does
this already — a case stores the rendered prompt, so the same evidence is scored
every time. The correlation set was not doing it: **half its input was being
re-derived by a model at capture time.**

So the verdict is now a fixture. `src/eval/verdicts/<scenario>.json` holds a
real Tier 2 output — severity, summary and affected area, recorded from a real
run — and capture reads it instead of calling the classifier again.

This is not a cheat, and the distinction matters. The stored verdict is as real
as the stored context; what changes is that it stops being redrawn. A Tier 2
eval holds the log evidence fixed and varies only the model under test; a Tier 3
eval should hold Tier 2's conclusion fixed for the same reason.

**Verified by capturing the set twice, from independent runs**, and comparing:
the severity, affected area and summary are byte-identical across both. The
traffic and the fixture shas still differ — those are inputs the correlator is
supposed to handle — but the judgement it inherits no longer moves.

Two side effects, both worth having:

- **Capture now calls no model at all.** It used to cost one classification per
  case on a free tier where quota is the binding constraint, and those calls
  were the source of the variance they were paying for.
- Capture no longer needs Tier 2 to have run, so a scenario Tier 2 would
  dismiss can still be captured deliberately. The pipeline is unchanged: a real
  correlation still reasons about what Tier 2 actually concluded, never about a
  stored answer.

**Re-pin deliberately**, when a scenario's evidence changes enough that its
stored verdict is no longer what Tier 2 would say. Expect scores to move — that
is a new capture generation, and numbers still do not cross between them.

### What was actually changed, and what was not

**The prompt was not touched.** It has been byte-for-byte unchanged since before
the first correlation run, exactly like the classifier's.

**Hunks are off by default.** The capability is built, tested and reachable
(`{ diffs: true }`, `--diff` on capture), and the shipped packet does not use it.
The change is unmotivated by current evidence, showed one regression, and grows
the packet 3.7× — a real cost on a quota-bound free tier. Shipping it would have
meant adopting on the strength of an argument after the measurement declined to
support it.

The a priori argument for hunks is unchanged and still good. It is waiting on a
golden set large and stable enough to answer the question, which is the same
thing the decline axis is waiting on.

### Widening the decline half, and what it immediately exposed

Two cases was the thinnest and most important part of the set, so two more were
added — `traffic-surge` and `orphan-refund-bug`, chosen to be different reasons
to decline rather than more of the same. Doubling that half changed what the
scorecard could see, in three ways.

**`llama3.2` answered the same commit to all six cases.**

```
  named the right commit    1/2    50%
  declined when it should   0/4     0%
  confidence               0.80 on every answer, right and wrong
```

Its one correct attribution is correct *by accident* — it names the pricing
commit unconditionally. On the four-case set the same behaviour read as 2/2
attribution, which looks like competence. Four decline cases and a constant
0.80 confidence make the degenerate strategy unmissable.

**`gemini-2.5-flash` failed two decline cases the smaller set never asked
about.** It attributed both `latency-jump` and `traffic-surge` to the pricing
commit, on a mechanism it invented in both — "this new feature likely requires
an additional call to the payments-service". Nothing in the packet says pricing
calls payments-service. That is the same failure recorded earlier: a plausible
story assembled from a subject line, and a mechanism no reviewer could check.

**And one of the new cases was mislabelled by its author.** See below.

### The case I got wrong, and how the model found it

`orphan-refund-bug` was supposed to have no plausible culprit in the window. Its
first version emitted `RangeError: refund window comparison received a
non-finite created_at`, and `gemini-2.5-flash` blamed the commit that changed
`created_at` from epoch milliseconds to an ISO 8601 string:

> This change likely introduced a type mismatch or parsing error in the refund
> logic, which expects a numeric or finite date value for comparison.

That is a substantive, checkable mechanism, and it is a good answer. It happens
to be wrong about this repository — `refunds.js` reads `created_at` straight
from the database, while that commit changed only the *presented* value in
`orders.js` — but the model cannot see `refunds.js`, because "no candidate
touches the refund path" is the entire premise of the case.

So the case was measuring whether the model could guess the author's intent, not
whether it could correlate. **The scenario was changed, not the label**: the
error now names a refund policy and a sales channel, concepts no commit in the
window goes near. The fixed case passes on the model that exposed the flaw.

This is the third label or fixture problem this harness has surfaced, after the
two in §7, and the pattern is worth naming: **a decline case is only as good as
the absence of a plausible culprit, and plausible is judged from the packet, not
from the source tree.**

### The number, and why it is not one number yet

On the corrected six-case set, `gemini-2.5-flash` scores:

```
  named the right commit    2/2   100%
  declined when it should   4/4   100%
  right files within it     2/2   100%
```

That is a clean sweep — and it should be read next to the fact that the *same
model* scored 1/4 on declining against the previous capture an hour earlier.
One of those three failures was the mislabelled case, now fixed. The other two,
`latency-jump` and `traffic-surge`, passed on this capture and failed on that
one.

Pinning the verdict removed the largest source of drift but evidently not all of
it. What still varies between captures is the generated traffic — and therefore
the trigger numbers rendered into the packet — and the fixture commit
timestamps. Whether that is enough to flip two cases, or whether the sampling
temperature of 0.1 is doing it, is **not established**: the repeatability check
(re-running identical stored packets several times) was started and blocked by
daily quota on both Gemini models.

Until that check runs, treat a single correlation run as one sample, not as a
measurement. The claim that survives is the one the baseline supports: the tier
beats "blame the newest commit", which scores 0/2 and 0/4 and has never scored
anything else.

### Chasing the noise floor, and what it narrowed to

The swing above — 1/4 declining on one capture, 4/4 on the next — has two
candidate explanations: the packets differed, or the model is not deterministic.
The direct test is to re-run identical stored packets several times. It was
attempted and is **not finished**: daily quota ran out on all three Gemini
models mid-run, and a broken output parser meant the calls that did land were
not recorded. Wasted quota, and the parser should have been validated on one
call first.

What could be established without quota narrows it considerably.

**Capture variance is essentially gone.** Comparing the same case across three
committed generations:

```
  gen1 (pre-pin)   area = /orders endpoints            p95 1273ms (7.88x)
  gen2 (pinned)    area = payments-service dependency  p95 1427ms (8.44x)
  gen3 (widened)   area = payments-service dependency  p95 1403ms (8.3x)
```

The pin did what it was supposed to: gen2 and gen3 are qualitatively identical
where gen1 differs. And the candidate half — every commit's short sha, age and
subject — is **byte-identical** between gen2 and gen3. The only residual
difference is trigger magnitude, about 2%.

**So the flip is unlikely to be the packet.** Two decline decisions changed
between adjacent captures whose evidence differs by 2% on one number. That
points at model sampling.

The inference has a gap worth naming: the capture the 1/4 was measured on was
never committed, so its similarity to gen3 is inferred from the two generations
either side of it rather than shown directly. Commit intermediate captures if
this needs settling properly.

**The local model is perfectly repeatable and it does not help.** `llama3.2`
gave byte-identical answers across three full runs of all six cases — 18/18. It
also answers the same commit to every case regardless of evidence, and a model
that ignores its input is trivially stable. It measures the plumbing, not the
question.

**One assumption turned out to be untested.** `llmConfig.temperature` is 0.1,
and the comment beside it claimed this "keeps the same window classifying the
same way across runs, which is what makes the eval harness meaningful". That was
an assumption written as fact, it has been carried since Phase 2, and the
evidence above is against it. The comment now says so.

`LLM_TEMPERATURE` overrides it, so the outstanding test is a command rather than
a code change: run the same stored packets at 0 and at 0.1, several times each,
and compare. A benchmark arguably wants 0 outright, or N samples with a reported
spread — but that is a change to evaluation method and should follow the
measurement, not precede it.

### The measurement, and the conclusion it overturned

The repeatability test finished the next day. Same stored packets, no
re-capture, so the model is the only variable.

```
  gemini-3.5-flash, temperature 0.1, three repeats of all six cases

  case                repeat 1     repeat 2     repeat 3
  error-spike         no commit    no commit    no commit
  latency-jump        no commit    no commit    no commit
  limiter-misconfig   9bfdbf91e4   9bfdbf91e4   9bfdbf91e4
  new-error           d3e6eb99d4   d3e6eb99d4   d3e6eb99d4
  orphan-refund-bug   no commit    no commit    no commit
  traffic-surge       no commit    no commit    quota
```

**Seventeen answers, zero decision flips.** Every case returned the identical
sha, or the identical decline, every time. Scores: 6/6, 6/6, 5/5.

What does move is confidence — `limiter-misconfig` reported 0.90, 0.95, 0.95
and `new-error` reported 0.90, 0.85, 0.90. So sampling noise at 0.1 is real and
it lands on the confidence, not on the answer.

`gemini-2.5-flash` scored 6/6 on this same capture, on two different days.

### So the earlier conclusion was wrong

The previous section reasoned that because the packets were near-identical, the
1/4-to-4/4 swing "points at model sampling". That inference is now refuted by
direct measurement: given a fixed packet, both models are decision-stable.

The swing therefore came from the **re-capture** after all — the thing the
earlier section had argued was too small to explain it. Which of the differences
did it is not knowable, because that capture was never committed. The
methodological lesson is the one already flagged and not acted on: **commit
intermediate captures**, or the evidence needed to explain a result is gone by
the time the result is interesting.

Recording this rather than quietly amending the earlier section, because the
sequence is the useful part. An argument from "the inputs look similar" lost to
a measurement, and the measurement cost eighteen calls.

### What the noise floor actually is

Two different numbers, and conflating them is what caused the confusion:

| | |
|---|---|
| **Re-running a stored case** | zero decision variance; confidence ±0.05 |
| **Re-capturing the set** | enough to flip two of four decline decisions |

So a score is reproducible against a fixed set of case files and is **not**
comparable across captures. A re-capture creates a new benchmark, and should be
treated as one — the way a changed prompt or packet already is.

That has a practical consequence for the hunks A/B in the section above. It was
run on packets captured from identical anomalies, which is the right design, so
its one-regression result stands on the axis it measured. It could not have been
run across separate captures at all.

**`LLM_TEMPERATURE` is not the lever it looked like.** It was added expecting to
show that 0.1 was costing repeatability. It is not: decisions are stable at 0.1
and lowering it further would buy nothing measurable. The override stays because
the question is now answerable rather than assumed, which is the point — the
comment that used to assert this without evidence is what prompted the check.

### Making a re-capture reproduce its predecessor

The noise floor above is two numbers only because re-capturing was
nondeterministic. That is now fixed, and the fix was smaller than the
investigation that found it.

The generator's PRNG has been seeded since Phase 0 and defaults to 42, so the
traffic *values* were already reproducible. What was not was the *timestamps*:
history ended at `Date.now()` floored to a minute, so two runs of the same
command landed on different minute boundaries relative to the detection window
and aggregated slightly differently. That is where the ~2% p95 difference came
from, and a couple of percent turned out to be enough to flip a correlation
decision.

`--end-at <iso>` pins the instant traffic ends at. The capture script sets it to
two minutes past the fixture's own **pinned** anchor, so both halves of the
packet now sit at one fixed point in time:

```bash
pnpm generate backfill --minutes 120 --end-at 2026-08-16T19:02:00Z
pnpm generate inject --scenario new-error --minutes 5 --end-at 2026-08-16T19:02:00Z
```

An unparseable `--end-at` throws rather than falling back to `now` — a silent
fallback would produce a capture that looks reproducible, is not, and gives no
sign of it until two runs disagree.

**Verified by capturing the whole set twice, from scratch, and diffing:**

```
  error-spike          context identical: True   label identical: True
  latency-jump         context identical: True   label identical: True
  limiter-misconfig    context identical: True   label identical: True
  new-error            context identical: True   label identical: True
  orphan-refund-bug    context identical: True   label identical: True
  traffic-surge        context identical: True   label identical: True
```

Every packet and every label byte-identical. The only field that moves is
`capturedAt`, which is provenance rather than evidence — and that gives a useful
invariant: **after a re-capture, `git diff` should touch only `capturedAt`.**
Anything else in that diff is a real change to the evidence, not capture noise,
which makes the whole capture path checkable by inspection.

Dropping `--anchor now` also brings back the fixture's documented shas, so the
commits named in `DOCUMENTATION-PHASE-3.md` §3 are once again the ones in the
cases.

### What this changes about everything above

Scores are now comparable across captures, which they have not been at any
earlier point in this document. Concretely:

- The hunks A/B can be re-run properly. It was already the right design —
  arms captured from identical anomalies — but it could not have been checked
  against a later capture. Now it can.
- Model comparisons can be run on different days without re-capturing being a
  confound.
- The two numbers in "What the noise floor actually is" collapse toward one.
  Within-capture variance was already zero for decisions; cross-capture
  variance is now zero by construction, and verified.

**The set was re-captured to get here, so no score in this document carries
over.** Two cases have been re-scored on the new capture and both are correct;
the rest is a quota away. That is the cost of the fix, and it is the last time
it should be necessary for this reason.

### What this does not establish

Four cases and one application shape. The decline half is **2 cases** — the
thinnest part of the set and the half that matters most, exactly as the benign
half does for Tier 2.

Six cases now, four of them declines. The inherited verdict is pinned and two
independent captures produce identical ones, which removed the largest source of
drift — but not all of it, as the swing described above shows. Repeatability on
identical packets is untested and is the next thing to measure.

The honest summary of Phase 3: it clearly beats its baseline, which scores zero
on both accuracy axes and has never scored anything else. Beyond that, single
runs are samples. Two attempts to settle a question with this harness are
written up above — the diff A/B and the decline widening — and both were more
useful for what they exposed about the harness than for what they said about the
models.

Reasoning quality is still not measured. `reasoning` is printed for wrong
answers, because the answer is as often a bad label as a bad model — two of the
six classifier labels were found that way — but grading prose needs a human or a
second model marking the first one's homework, and a number nobody should trust
is worse than no number.

---

## 15. Adding a correlation case

1. Add the scenario to `SCENARIO_NAMES` and `SCENARIOS` in the generator with
   `benign: false` — a benign scenario is dismissed by Tier 2 and never reaches
   correlation.
2. Give it evidence that links to a commit, or deliberately does not. The link
   should be checkable, not given away: no sha in any log line.
3. Verify it trips Tier 1 *and* that Tier 2 confirms it. If either fails, the
   case tests nothing, and `capture-correlation-cases.sh` says so loudly.
4. Add it to that script with `--sha <sha|none>` and a `--note` that argues for
   the label.

`--sha` is resolved against the candidates in the packet being captured, and
capture fails if it matches none. A case expecting a commit its own evidence
does not contain would score every model wrong forever and look like a model
problem rather than a labelling one.
