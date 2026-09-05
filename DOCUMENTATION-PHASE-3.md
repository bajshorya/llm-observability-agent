# Phase 3 — Commit Correlation

Phase 2 ends with rows in `anomalies` that are real, described and prioritised:
`is_real_incident = 1`, a severity, a plain-English summary, an affected area,
and status still `open`. Phase 3 asks the next question — **which commit did
this?**

This document covers what has been built so far: the decision that was blocking
the phase, the target repository, the commit contract, the collector, the
evidence packet, the prompt, the orchestration and the eval. **Phase 3 is
complete and measured.** The result — and the one repeatable failure it exposed
— is in `DOCUMENTATION-EVALS.md` §14; §12 is the inventory.

---

## 1. What this phase is for

Every tier so far reads the same data source. Ingestion, rollups, the detectors
and the classifier all look at one thing: what the service did. They differ in
how expensively they look at it.

Correlation is the first step that reads something else. It puts runtime
behaviour next to source history and draws a causal conclusion across the two.
That is the step that makes this system agentic rather than a wrapper around a
model — not because it calls an LLM (Tier 2 already does), but because the
conclusion is not present in either input on its own.

| Field | Question |
|---|---|
| `suspectedCommitSha` | Which commit, or none? |
| `confidence` | How sure, 0–1? |
| `reasoning` | Why that one, in terms a reviewer can check? |
| `changedFilesImplicated` | Which files in it are doing the damage? |

The nullable first field is the whole design. See §4.

---

## 2. The decision that was blocking this phase

`CLAUDE.md` carried an open decision from the end of Phase 2:

> The correlation agent needs commits that genuinely explain the injected bugs.
> The generator currently references a fabricated sha (`a3f9c21`). Phase 3 needs
> either a real repository with real history to correlate against, or a
> synthesized history committed as a fixture.

Nothing in the phase could be designed before it was settled — the evidence
packet, the prompt and the golden cases all derive from what the commits
actually are. The two options in the note were not the only ones, and the one
taken is a third:

| Option | Verdict |
|---|---|
| A real external repository | Real history, but nothing in it causes the injected bugs, so every case correctly answers `null` and the positive path is never exercised. Adds a network dependency and a moving target. |
| Synthesized history as a JSON fixture | Fastest to build, but the collector never parses real `git log` output, so that layer stays untested and a demo cannot show real history. |
| **A real git repository, built by a script** | **Taken.** Real shas, real timestamps, real `git log --numstat`, so the collector is real code. Deterministic and dependency-free. |

**The trade-off accepted:** the history is still authored by us, so a critic can
say the correlation task was made findable. That objection is answered in §3 —
by the decoys, not by asserting otherwise.

---

## 3. The target repository — `scripts/build-fixture-repo.sh`

A minimal `orders-api` — 12 files, ~170 lines, never runs — with twelve real
commits spanning nine days. `bash scripts/build-fixture-repo.sh` builds it at
`fixtures/orders-api`.

### What makes it a real test

A commit history with one obviously guilty commit tests nothing. The model picks
it by elimination and the eval is theatre. This is the same discipline the
benign scenarios enforce on the classifier: the system is only credible if it
can decline, and only measurable if a wrong answer was available.

So the history is built to defeat three cheap heuristics:

| Heuristic | What defeats it |
|---|---|
| "pick the most recent commit" | `8a38dbc` (CI cache) lands *after* the bug |
| "pick the file that sounds relevant" | three commits touch `pricing.js`; one is the bug |
| "always name something" | `884518a` (token bucket) is a tempting candidate for `rate-limit-storm`, where the correct answer is still `null` |

### The history

```
  8a38dbc  2026-08-16 18:20  chore(ci): cache the pnpm store between runs      ← after the bug
  0c701a0  2026-08-16 17:25  feat(pricing): show the promotional total         ← THE BUG
  465f015  2026-08-16 13:00  docs: describe the refund window and rate limits  ← docs-only decoy
  0c4abb1  2026-08-15 17:00  refactor(pricing): extract formatPrice            ← same-file decoy
  fcfc4c0  2026-08-15 13:00  feat(orders): return created_at as ISO 8601       ← same-file decoy
  884518a  2026-08-15 09:00  feat(ratelimit): per-client token bucket          ← rate-limit decoy
  e381f77  2026-08-13 19:00  chore(deps): bump express to 4.19.2
  085857c  2026-08-12 19:00  perf(db): index orders.created_at
  1b197b5  2026-08-11 19:00  test: cover the order list and detail routes
  05ca6f8  2026-08-09 19:00  feat(refunds): add POST /orders/:id/refund
  80daa69  2026-08-08 19:00  feat(orders): add GET /orders/:id
  31e98ce  2026-08-07 19:00  chore: initial orders-api scaffold
```

The bug, in `src/lib/pricing.js`:

```js
function formatDiscountedPrice(order) {
  return formatPrice(order.discounted_cents);   // NULL unless a promotion applied
}
```

`discounted_cents` is NULL for any order without a promotion — which is most of
them — and `formatPrice` calls `.toFixed(2)` on it. That produces exactly the
error the `new-error` scenario emits:

```
TypeError: Cannot read properties of null (reading 'toFixed')
```

### Why it is generated rather than committed

A git repository nested inside this one is awkward to review and easy to
corrupt. Instead the script pins every commit's author date, committer date,
author identity and message, so the resulting shas are **byte-identical on every
machine, every run** — verified across rebuilds. The history is a deterministic
function of one reviewable shell script. Diff the script and you have diffed the
fixture.

`fixtures/orders-api/` is therefore gitignored, and a fresh clone builds it.

### Two details that are load-bearing

**The anchor is pinned to `2026-08-16T19:00Z`**, the day the golden cases were
captured. All six share the window 18:57–19:02Z, so the buggy deploy lands 95
minutes before it rather than a year adrift. `--anchor now` rebuilds relative to
the present for a live demo, at the cost of different shas.

**The sha appears in the scenario description and in no emitted log line.** A
packet containing the answer would test nothing but a model's ability to copy a
string. This is the correlation-stage equivalent of the classifier's grounding
check, and it is a property of the generator that has to be actively preserved —
see §13.

---

## 4. The commit contract — `shared/src/schemas/commit.ts`

Source history is the second data source, and the only one that does not come
from the running service. It gets the same treatment as every other boundary:
validated with Zod before anything downstream sees it.

That is not ceremony here. `git log` output is text from a subprocess, and it is
*parsed* — and parsers are wrong in ways that stay invisible until a field
renders as `undefined` three functions later.

**`candidateCommitSchema`** — sha (full 40), `committedAt`, author, subject,
body, files.
**`changedFileSchema`** — path, added, deleted.
**`commitWindowSchema`** — the commits, plus `since` and `until`.

Three field decisions worth the words:

**Line counts are nullable, not defaulted to zero.** `git log --numstat` prints
`-` for a binary file. "0 lines changed" is a different claim from "the line
count does not exist". Zero is a measurement; null is the absence of one.

**Subject and body are kept apart** rather than stored as one message blob. They
carry different weight as evidence — the subject is the one-line claim a
developer chose, the body is where the reasoning and the trade-off live — and
the prompt will render them differently for that reason.

**`commitWindowSchema` carries `since` and `until`** alongside the commits, so
"no commit explains this" stays distinguishable from "we never looked". A
correlation naming nothing is only meaningful if you know whether it was
choosing from twelve candidates or from none.

### Why `suspectedCommitSha` is nullable

It was already nullable in `agents.ts`, written in Phase 2 before any of this
existed, for the reason recorded there: *a model with no null available will
invent one.*

Everything in this phase follows from taking that seriously. The lookback bounds
in §6, the decoys in §3, and the `--until` rule below are all there to make
`null` an answer the system can arrive at honestly rather than one it is
cornered into.

---

## 5. The collector — pure and impure

The same split as `detectors.ts` / `engine.ts`, for the same reason.

```
  git log stdout ──▶ commits.ts (pure)   ──▶ CandidateCommit[]
                     no subprocess, no clock, no database
                                │
  TARGET_REPO_PATH ──▶ git.ts (impure)   ──▶ CommitWindow
                       spawns git, resolves the path, bounds the lookback
```

The tests that result need no repository, no fixture and no filesystem — just
strings. That matters more here than usual, because the cases worth testing are
exactly the ones that are painful to produce on demand in a real repo: a body
containing a control character, a binary file, a commit that touches nothing.

### The parse format, and why it looks like that

Commit bodies contain newlines, blank lines, colons, and anything else a
developer typed. Any parser keyed on human-readable punctuation is one unusual
commit message away from being wrong — and wrong here means **mis-attributing a
cause**, not crashing.

So the format uses two ASCII control characters that cannot appear in git
metadata:

```
\x1e  RECORD SEPARATOR   brackets each commit header
\x1f  UNIT SEPARATOR     between fields inside a header
```

`GIT_LOG_FORMAT` opens *and* closes each header with `\x1e`, so splitting stdout
on `\x1e` yields alternating chunks: `["", header, numstat, header, numstat, …]`.
The body is the last field inside the header, where its newlines are harmless.

### Two separators, two different defences

**`\x1f` is fully handled.** The body is the last field, so it is split off by
*position*, not by counting: everything after the fourth separator is body,
however many separators it contains.

This was not the first implementation. The first version split on `\x1f` and
counted five fields, and the test with a unit separator in the body failed it.
Worth recording because of the failure mode: a parser that mis-splits produces a
*wrong answer*, not an error, and a mis-attributed commit looks exactly as
confident as a correct one.

**`\x1e` is not fully closable in this format.** A record separator inside a
body destroys the bracketing, and the body's tail becomes indistinguishable from
the numstat block after it. Closing that would need git to frame the records
itself.

What the parser does instead is **detect** it, with two guards that between them
leave no quiet path through: a header chunk must open with 40 hex characters and
a separator, and a numstat chunk must contain only `added\tdeleted\tpath` lines.
A stray `\x1e` trips one or the other depending on where it lands. The
pathological commit message therefore produces a loud failure rather than a
commit silently attributed to the wrong sha — which is the only outcome that
would actually matter.

### A malformed record throws rather than being skipped

Skipping it would produce a correlation over a history with a hole in it, and
that answer would look exactly as confident as a correct one. Loud is better.

---

## 6. The lookback, and why it is a trade

`collectCommits` bounds what it fetches. Both failure modes are real:

| | |
|---|---|
| **too narrow** | the guilty commit is outside the window, so the only available answers are wrong ones or `null` — and a `null` here is right for the wrong reason, which is worse than useless because it looks like the system working |
| **too wide** | forty commits of noise, and the model's job becomes a needle hunt. Input tokens grow linearly and precision falls |

`defaultLookback` is **48 hours and 25 commits**, whichever binds first. Wide
enough to cover a bug that shipped Friday and surfaced under Monday load; narrow
enough that a typical result is a page of text.

**Both numbers are arguments, not measurements.** The correlation set is six
cases; tuning a bound against six cases would mean nothing — the same reasoning
that keeps both prompts unchanged, and that left the `latency-jump` failure
written up rather than patched. They are stated in the file header
so the next person can disagree with a number rather than discover one.

### `--until` is the end of the anomaly window

A commit made after the anomaly ended cannot have caused it. Passing `--until`
to git rather than filtering afterwards means those commits are never fetched,
never rendered and never offered — the model is not given the chance to pick a
cause that postdates its effect.

### One thing this bound already caught

The rate-limiter decoy was originally committed at T−2d. The lookback ends 48
hours before the anomaly window closes, so it fell **two minutes outside** and
was never offered as a candidate — which defeated its entire purpose.

It was moved to T−34h. The commit moved, not the bound: 48 hours is a defensible
general default, and widening it to fit our own fixture would be fitting the
system to the test rather than the other way round.

---

## 7. The evidence packet — `correlation/context.ts`

Pure, like its Tier 2 counterpart: same input, same text out, no clock and no
database. Every date it renders comes from the input, which is why "1h 37m
before the window" is reproducible rather than a function of when it ran.

### Two halves, one seam

This is the first packet in the system built from two sources, and it is laid
out to make that visible:

| Half | Carries |
|---|---|
| **The incident** | service, window, severity, affected area, the classifier's summary, and the detector evidence |
| **The candidates** | each commit's sha, timestamp, age relative to the window, author, subject, body and files |

The classifier's verdict is included so the correlator does not silently
re-litigate whether this is an incident at all. That question was answered
upstream, and a stage that quietly re-answers it is a stage whose output cannot
be attributed.

### Normalisation helps Tier 1 and hurts this tier

`describeTrigger` prints the **normalised** signature, because that is what the
new-signature detector actually compared against the baseline. Normalisation is
what makes that detector work — it collapses `reading 'toFixed'` and
`reading 'toUpperCase'` into one shape, so a thousand ids do not look like a
thousand novel errors.

For correlation it removes the one token that points at code:

```
reading '<str>'      matches nothing in a repository
reading 'toFixed'    matches a file about formatting money
```

So the packet prints the raw sample **alongside** the collapsed shape rather
than instead of it. The shape says how the detector saw it; the sample says what
actually happened.

This packet was written without the raw line, and its own test caught it. Worth
recording, because the failure was invisible in the classifier — Tier 2 gets the
raw text elsewhere, in its signature table and log sample, so nothing upstream
was wrong. The loss only appears at the stage that needs to match a string
against source code.

### The budget

25 commits, 12 files per commit, 400 chars of body, 300 of raw error text, 200
of subject. Commits are the expensive axis; the collector already caps them at
25, and this cap exists so that widening `--lookback` cannot silently produce a
prompt nobody sized.

The body budget is generous relative to Tier 2's 240-char log lines, and the
rendered fixture packet shows why. The two most confusable candidates —
`0c701a0` and `0c4abb1` — touch the *same two files* with similar subjects. What
separates them is entirely in the bodies: "adds discounted_total" versus "three
call sites were formatting money inline". Cut the body and the packet stops
containing the answer.

### Three decisions worth arguing with

**Short shas are rendered, not full ones.** A model copying 10 hex characters
has fewer chances to typo than one copying 40, and `correlationSchema` accepts
7–40 precisely so an abbreviation is not rejected. Orchestration will resolve
the answer back against the candidate list, which also catches an invented sha —
the correlation-stage equivalent of `eval/grounding.ts`.

**Commits are rendered newest first.** That is the order git prints them and the
order a developer reads them. It is also, uncomfortably, the order that
encourages the recency heuristic the fixture history exists to defeat. The
alternative — shuffling, or oldest-first — would be arranging the evidence to
influence the answer, which is a worse failure than the one it prevents. The
prompt is where "recent is not the same as guilty" belongs.

**"No candidates" is stated, not omitted.** An absent section reads as *not
provided*; the model needs the difference between "we searched and found
nothing" and "we did not look", because only one of those makes `null` correct
rather than a guess. The same reasoning applies to a commit that touched no
files, which is printed as such.

### What it looks like

Abridged, from a real render against the fixture:

```
Service: orders-api
Window: 2026-08-16T18:57:00.000Z to 2026-08-16T19:02:00.000Z (5 min)
Severity: critical
Affected area: GET /orders and GET /orders/:id order read paths

Already established by the classification stage:
  A novel TypeError is returning 500s on order read paths; a code change is
  failing in production.

What the statistical detectors found:
- new_error_signature: "TypeError: Cannot read properties of null (reading
  '<str>')" occurred 109 times and appears nowhere in the baseline hour
    raw example: TypeError: Cannot read properties of null (reading 'toFixed')
- error_rate_spike: 111 errors in the window against a baseline of 0.53/min
  (sd 0.79, z=27.38)

Candidate commits (6), searched 2026-08-14T19:02:00.000Z to
2026-08-16T19:02:00.000Z, newest first:

  8a38dbc5a4  2026-08-16 18:20Z  42m before  —  orders-api ci
    chore(ci): cache the pnpm store between runs
      Install was 90 seconds of every run. Cache key is the lockfile hash.
    files (1):
      .github/workflows/ci.yml  +13/-0

  0c701a0bcc  2026-08-16 17:25Z  1h 37m before  —  orders-api ci
    feat(pricing): show the promotional total on order responses
      Adds discounted_total to every order response so the storefront can
      strike through the original price without a second call.
    files (2):
      src/lib/pricing.js  +7/-1
      src/routes/orders.js  +2/-1

  …
```

---

## 8. The prompt — `correlation/prompt.ts`

One exported constant, in its own file, for the same reasons as
`classification/prompt.ts`: a prompt is a versionable artefact, `git log` should
be able to answer "what did it say at the time", and a constant caches well on
providers that support prompt caching.

~915 tokens, comparable to the classifier's. Written **before any model was
called with it** and before any correlation golden case exists — the same
ordering the classifier prompt has held to byte-for-byte since before its first
real run, including through runs that scored badly.

### It is built around three failure modes

Each one a capable model walks into unprompted, and each one the fixture history
is built to expose:

| Failure | Why it happens |
|---|---|
| **Recency** | the newest commit is the obvious answer and is usually wrong |
| **Filename match** | a commit touching a plausibly-named file looks guilty |
| **Answering anyway** | a model handed a list will pick from the list |

### The distinction that needed care

"Recency is not guilt" is easy to state and easy to overshoot. Recency *is*
evidence — a change that shipped twenty minutes before an error first appears is
genuinely more likely to be responsible than one from two days earlier, all else
equal. The error is treating it as **sufficient**, not as relevant.

So the prompt does not say to ignore timing. It says:

> Timing narrows the field; it does not decide it.

which is what an engineer actually does at three in the morning. A prompt that
told the model to disregard recency would trade one bias for another and would
be wrong more often on real incidents, where the guilty commit usually *is*
recent.

### A stated mechanism is the bar

`reasoning` exists to be checked by a human. "This commit is recent and touches
orders" can be neither verified nor refuted. "This commit added a call to
`.toFixed` on a field the schema allows to be null, and the error is a null
dereference on `toFixed`" can be confirmed in thirty seconds by opening the diff.

Requiring a mechanism is therefore not a style preference — it is what makes a
wrong answer *detectably* wrong, the same property `eval/grounding.ts` gives
`affectedArea` in Tier 2.

### Ruling out, not ranking

One instruction earns its place on the fixture directly: a change to CI
configuration, documentation, tests or tooling does not run in production and
cannot throw an error there. Those are eliminated rather than scored, which
removes two of the six candidates in the rendered packet before reasoning
begins — including the newest one.

### Confidence bands are spelled out

| Band | Means |
|---|---|
| 0.8–1.0 | the error text names something this commit demonstrably introduced |
| 0.5–0.8 | the commit changed the affected path and the timing fits, but the mechanism is inferred |
| 0.2–0.5 | plausible, but another candidate explains it about as well |
| below 0.2 | guessing — prefer `null` |

Same reasoning as the classifier's severity bands: 0.7 means different things to
different models, and an uncalibrated confidence is worse than none because it
invites downstream code to threshold on it. Phase 4 will.

### The prompt is tested — for discipline, not for wording

`prompt.test.ts` does not assert phrasing; a prompt's quality is measured by an
eval, not by a unit test. It guards one regression an eval **cannot** catch,
because it makes the eval meaningless:

The obvious way to raise a correlation score is to put an example in the prompt
— name the file, quote the error, describe the answer's shape. It works, and it
invalidates every number produced afterwards.

`CLAUDE.md` states the rule. A rule living only in a document survives exactly
as long as the next person who has not read it, so the test fails CI instead. It
checks that no fixture identifier appears (`toFixed`, `pricing.js`,
`orders-api`, seven others), that no commit sha appears, and that no worked
example is offered at all.

Verified by deliberately inserting a leak: three of the guards fired, naming the
offending string.

**Nothing fixture-specific appears in the prompt.** The `.toFixed` example above
is in this document and in the file's header comment — neither of which the
model ever sees.

---

## 9. Orchestration — `correlate.ts`, `grounding.ts`, `pnpm correlate`

The impure stage, plus the pure check that stands between a model's answer and
the database.

### What "uncorrelated" means

A real incident with no `correlations` row: `is_real_incident = 1` and no
matching row. Two things follow.

**Benign windows are never correlated.** Tier 2 already dismissed them, and
looking for the commit that caused a rolling restart is precisely the wasted
call the two-tier design exists to avoid. The funnel narrows a second time here.

**The absence of a row is the flag, not a status value.** `status` does move
`open → correlated`, but keying the query off `status` would mean an anomaly a
later phase moved on got silently re-correlated. Same rule, same reason, as
Tier 2's `severity IS NULL`.

### A null sha is still a row

"No commit explains this" is a finding, and it costs a model call to reach.
Writing it down means the next run does not pay for it again, and it makes "the
correlator declined" visible in the data rather than indistinguishable from "the
correlator never ran".

`status` moves to `correlated` either way. The status records that the stage
ran, not that it succeeded in blaming something.

### Grounding: two failure kinds, treated differently

`correlationSchema` guarantees the answer is well-**formed**. It cannot
guarantee it is **true to the evidence**, because it has never seen the
evidence. `"deadbeef"` is a valid sha and may correspond to no commit anywhere.

This is `eval/grounding.ts`'s question asked of the correlator — with one
difference that matters: this check runs in the **pipeline**, not only in the
eval. A hallucinated sha would be written to `correlations` and inherited by
Phase 4 as established fact.

| Kind | Treatment | Why |
|---|---|---|
| **Invented sha** | fatal; no row written | The sha *is* the causal claim. Coercing it to `null` would record a hallucination as a considered "no commit explains this" — corrupting the one measurement the nullable field exists to make possible |
| **Invented file** | dropped and reported | The sha still points at a real diff a human can open, so the answer stays checkable. The file list is supporting detail |

An ambiguous prefix matching two candidates is treated as ungrounded rather than
resolved to the first. Two commits sharing a 7-character prefix in a 25-commit
window is vanishingly unlikely, and guessing between them would attribute an
incident to a coin flip.

Prefixes resolve **against the candidate list**, not by asking git. That means
resolution cannot succeed for a commit the model was never shown: the lookup and
the grounding check are the same operation.

### A Phase 2 gap this stage exposed

`affectedArea` was produced by the classifier, printed by `pnpm classify`, and
scored by the eval — and **never written to the database**. It lived only as
long as the process that generated it.

Nothing upstream was wrong, which is why it went unnoticed: every Phase 2
consumer used it inside the same call that produced it. Correlation is the first
consumer that needs it *later*. The column was added and
`persistClassification` now writes it.

### The stub had to learn a second agent

The stub provider threw for any agent but `classifier`, so `pnpm correlate`
would have failed by default — breaking the property that the whole pipeline
runs for someone with no API key.

The baseline it implements is **blame the newest commit**: the thing you would
actually build without a model, and the heuristic every team reaches for first.
It is also exactly what the fixture is built to defeat, so the control fails on
the positive case *and* would attribute the benign ones. The alternative — a
stub that always declines — would score perfectly on every `null` case while
doing no work, which flatters the baseline and makes the comparison useless.

It names no files rather than guessing, and its reasoning says "no model was
called" in as many words.

### The CLI

```
pnpm correlate                    # up to 10 real incidents
pnpm correlate --preview          # the exact prompt, calls nothing
pnpm correlate --provider stub    # the naive baseline
pnpm correlate --lookback 168     # widen the commit window for one run
pnpm correlate --repo <path>      # a different checkout, without editing .env
pnpm correlate --stats            # the funnel
```

Two output details that are not decoration. The **candidate count** is printed
on every line, because declining from twelve candidates and declining from zero
are completely different findings that otherwise read identically. **Dropped
files** are printed as a warning rather than hidden, because a model inventing
paths is a signal about that model worth seeing.

`--preview` is a boolean and `--anomaly` picks the target, rather than
`--preview <id>` as in Tier 2. `parseArgs` has no optional values — a string
option always consumes the next argument, so `--preview` alone would fail rather
than defaulting to the latest incident.

---

## 10. Files

| File | Lines | Pure? | What |
|---|---|---|---|
| `shared/src/schemas/commit.ts` | 93 | contract | `candidateCommitSchema`, `changedFileSchema`, `commitWindowSchema` |
| `backend/src/correlation/commits.ts` | 214 | **pure** | `GIT_LOG_FORMAT`, `GIT_LOG_ARGS`, `parseGitLog` |
| `backend/src/correlation/git.ts` | 145 | impure | `defaultLookback`, `resolveTargetRepo`, `collectCommits` |
| `backend/src/correlation/context.ts` | 280 | **pure** | `correlationBudget`, `describeAge`, `renderCorrelationContext` |
| `backend/src/correlation/commits.test.ts` | 195 | — | 15 cases, all plain strings |
| `backend/src/correlation/prompt.ts` | 137 | constant | `CORRELATOR_SYSTEM_PROMPT` |
| `backend/src/correlation/context.test.ts` | 196 | — | 13 cases, all literals |
| `backend/src/correlation/grounding.ts` | 130 | **pure** | `groundCorrelation` — the answer checked against the evidence |
| `backend/src/correlation/correlate.ts` | 372 | impure | orchestration, persistence, funnel, preview |
| `backend/src/correlation/cli.ts` | 239 | — | `pnpm correlate` |
| `backend/src/correlation/prompt.test.ts` | 92 | — | 6 cases guarding prompt discipline |
| `backend/src/correlation/grounding.test.ts` | 162 | — | 11 cases, hallucinations included |
| `backend/src/eval/correlation-cases.ts` | 123 | contract | the correlation case schema, loading, saving |
| `backend/src/eval/score-correlation.ts` | 197 | **pure** | the four axes |
| `backend/src/eval/run-correlation.ts` | 96 | impure | the cases through a provider |
| `backend/src/eval/score-correlation.test.ts` | 232 | — | 21 cases over the scoring rules |
| `scripts/capture-correlation-cases.sh` | 146 | — | rebuilds the correlation set |
| `scripts/build-fixture-repo.sh` | 503 | — | the target repository |

Three `git log` flags are worth knowing about, all in `GIT_LOG_ARGS`:

- `--numstat` — per-file line counts. The difference between "this commit
  touched pricing" and "this commit rewrote pricing".
- `--no-renames` — a rename is reported as its real path rather than a
  `{old => new}` expression the parser would have to understand.
- `--no-merges` — merge commits introduce no changes of their own. Offering one
  as a candidate is offering the model a cause that cannot be one.

---

## 11. Verified behaviour

`pnpm typecheck` clean. **177 tests pass**, up from 81 — 19 for the parser and
packet, 6 for prompt discipline, 11 for grounding, 4 for the stub's baseline, 21
for the correlation scorer, 6 for diff rendering and 5 for the pinned verdicts.
Only the last reads the filesystem, and only to validate committed fixtures.

The collector against the real fixture, for the golden window ending
`2026-08-16T19:02Z`:

```
since 2026-08-14T19:02:00.000Z  until 2026-08-16T19:02:00.000Z
6 candidate commits

  8a38dbc  2026-08-16T18:20  chore(ci): cache the pnpm store between runs
           files: .github/workflows/ci.yml (+13/-0)
  0c701a0  2026-08-16T17:25  feat(pricing): show the promotional total on order responses
           files: src/lib/pricing.js (+7/-1), src/routes/orders.js (+2/-1)
  465f015  2026-08-16T13:00  docs: describe the refund window and rate limits
           files: README.md (+14/-0)
  0c4abb1  2026-08-15T17:00  refactor(pricing): extract formatPrice into lib/pricing
           files: src/lib/pricing.js (+7/-0), src/routes/orders.js (+6/-1)
  fcfc4c0  2026-08-15T13:00  feat(orders): return created_at as ISO 8601
           files: src/routes/orders.js (+6/-2)
  884518a  2026-08-15T09:00  feat(ratelimit): per-client token bucket on write paths
           files: src/middleware/rateLimit.js (+28/-0), src/server.js (+2/-0)
```

Six candidates: the bug, one commit after it, two other commits touching the
same file, a docs-only change, and the rate-limiter. That is the shape the
prompt has to work against — and deliberately not an easy one.

Determinism is checked by rebuilding and comparing:

```bash
bash scripts/build-fixture-repo.sh
git -C fixtures/orders-api log --format=%H | md5     # same every run
```

### One observed end-to-end run

Against a scratch database: 120 minutes of baseline, the `new-error` scenario
injected, `pnpm detect`, `pnpm classify`, `pnpm correlate`. The fixture was
rebuilt with `--anchor now` so its history sat inside the lookback of a window
generated today — which is what that flag is for.

The **stub baseline** blamed the newest commit, a CI-configuration change that
cannot throw in production. Wrong, by construction.

**`gemini-3.5-flash`** named the bug commit at confidence 0.90, and its
reasoning stated the mechanism rather than a correlation:

> introduced `discounted_total` to order responses … This change likely passes a
> null or uninitialized value to the recently extracted `formatPrice` helper
> (introduced in `b103ced763`), which formats prices using `.toFixed()`.

Note what it did with `b103ced763` — the same-file decoy. It cited it as
*context* for the mechanism and did not blame it, which is the distinction the
decoy exists to test.

Both wrote a row, resolved the 10-character answer back to the full 40-character
sha, and moved status to `correlated`. Re-running reported nothing to do. Cost
was attributed per agent in `llm_calls`.

### And the measured result

The eval exists now: six cases, two attributable to **different** commits, four
where the correct answer is `null` and six candidates are offered anyway.

The set is six cases: two attributable to different commits, and **four
declines that are four different reasons to answer null** — an upstream
dependency, that dependency degrading, a load change, and a real code bug whose
cause is older than the lookback.

On the deterministic capture, with and without hunks in the packet:

```
                          gemini-2.5-flash      llama3.2 (3B)       stub
                          plain    hunks        plain    hunks
  named the right commit   2/2      2/2          2/2      0/2        0/2
  declined when it should  2/4      4/4          0/4      0/4        0/4
```

Hunks fix both of the capable model's decline failures and destroy the weak
model's attribution — the packet grows 3.7× and it falls back to naming the
newest commit. So `CORRELATION_DIFFS` is a switch, default off. §14 of the
evals document has the reasoning and what is still missing.

The baseline scores zero on both accuracy axes — the fixture history is built so
"blame the newest commit" is never right, and it names a commit on both decline
cases too.

**Reproducible, and now deterministic across captures too.** Re-running the
stored cases gives zero decision variance over 17 answers. Re-capturing used to
flip decisions — the generator's timestamps were wall-clock — and `--end-at`
pins them, verified by capturing twice and diffing. `DOCUMENTATION-EVALS.md` §14.

**The widening did its job immediately.** `llama3.2` answers the same commit to
all six cases; on the old two-case decline half that read as 2/2 attribution and
looked like competence.

That pointed at the evidence rather than the prompt: the packet offers
`src/routes/orders.js +2/-1` and no hunks, so a model cannot tell whether two
lines are a string format or a synchronous network call. Counts can implicate a
commit; they cannot **exonerate** one.

Hunks were built and measured before being adopted, on packets captured from
identical anomalies so the arms differed only in the diff. The A/B did not
support the change — it cost one regression on one model, and the failure that
motivated it did not reproduce. **Hunks are off by default**, the capability is
kept, and the reasoning is in `DOCUMENTATION-EVALS.md` §14.

The more consequential finding came out of the same exercise: **correlation
cases were not stable across captures.** A case embeds the classifier's verdict,
and when Tier 2 happens to name an external cause the correlator's job becomes
much easier. Same scenario, same label, materially different difficulty.

That is fixed. The verdict is now a pinned fixture in
`src/eval/verdicts/<scenario>.json` — real Tier 2 output, recorded rather than
redrawn — and capture reads it instead of calling the classifier. Verified by
capturing the set twice from independent runs: severity, affected area and
summary are byte-identical across both. Capture also stopped making model calls
entirely, since those calls *were* the variance.

Six cases, one application shape, four of them declines. The inherited verdict
is pinned, which removed the largest source of drift but not all of it — see the
1/4-to-4/4 swing above. The claim that survives every capture is the one the
baseline supports.

---

## 12. What is not built

| Piece | State |
|---|---|
| Target repository | ✅ Built |
| `candidateCommitSchema` etc. | ✅ Built |
| Commit collector, pure + impure | ✅ Built |
| `correlation/context.ts` — the evidence packet | ✅ Built |
| `correlation/prompt.ts` — `CORRELATOR_SYSTEM_PROMPT` | ✅ Built |
| `correlation/correlate.ts` — orchestration, persistence | ✅ Built |
| `pnpm correlate` CLI | ✅ Built |
| Golden cases for correlation | ✅ Built — 6 cases, 4 of them declines |
| Correlation eval and scorecard | ✅ Built — `pnpm eval --correlation` |
| `correlations` table | ✅ Written by `correlate.ts` |

Nothing remains in Phase 3 as code. The set is re-scored on the deterministic
capture, the hunks A/B has been re-run properly and reversed its earlier result,
and two models have been compared on identical evidence.

What is left is one measurement: **`gemini-3.5-flash` on this capture, both
arms**. It is the model that regressed in the earlier A/B, so it is the one
whose result decides whether `CORRELATION_DIFFS` should default on. Its daily
quota went on the repeatability run.

---

## 13. The open decision, blocking the golden cases

The `deploy-restart` scenario emits this log line, and it reaches the model
inside the evidence packet:

```
orders-api v1.4.2 starting up (deploy 7c1e044)
```

`7c1e044` is fabricated and matches nothing in the fixture history.

**The case for changing it:** pointing it at a real fixture commit would make
the strongest `null` test in the set. The log would name a real commit that a
model can look up in its candidate list, and the correct answer would *still* be
`null`, because the restart recovered inside the window and the commit is
innocent. That is a much harder question than one where no candidate is
mentioned at all.

This decision does **not** block the packet or the prompt — an earlier draft of
this document said it did, which was wrong. The correlation packet is a new
artefact and does not depend on that log line. What it blocks is *capture*:
changing the line invalidates cases, so it wants settling before any are stored.

**The case against changing it now:** that line is *in the classifier's evidence
packet*, so changing it invalidates all six existing golden cases — the standing gotcha in
`CLAUDE.md`. It needs a full `bash scripts/capture-cases.sh` rebuild plus Gemini
quota, and recapturing shifts the window to the capture date, which moves it off
the anchor the fixture was just aligned to (§3).

**Current position:** leave it. A deploy sha absent from the candidate list is
realistic on its own terms, and the `null` path is still exercised by `batch-job`
and `rate-limit-storm`. Revisit it as a deliberate change once the correlator
exists and there is something to measure the improvement against — which is the
right order anyway, since right now the improvement would be unmeasurable.

---

## 14. Trade-offs

| Decision | Cost accepted |
|---|---|
| Fixture history authored by us | A critic can say the task was made findable. Mitigated by the decoys and the two `null` cases, not by denial |
| Generated, not committed | A fresh clone must run the script before `pnpm correlate` works |
| Anchor pinned to the capture date | `--anchor now` gives a coherent live demo but different shas, so golden cases and demos cannot share one build |
| 48h / 25 commits | Both unmeasured. A bug that shipped a week before it surfaced is outside the window and will correctly-but-uselessly return `null` |
| `--no-merges` | A squash-merge workflow puts the real change *in* a merge commit. This fixture does not use one; a real repository might |
| Two control characters as framing | Fully defends `\x1f`, only detects `\x1e`. See §5 |

---

## 15. Known limitations

- **No model has been run against this.** Everything above is plumbing and
  argument. The phase's actual claim — that an LLM can pick the guilty commit
  out of six plausible ones — is unproven.
- **One repository, one service.** `TARGET_REPO_PATH` is a single path. A real
  deployment correlates a service against the repo that builds it, and a
  monorepo of twelve services against twelve path prefixes.
- **No diff content.** The packet will carry subjects, bodies and per-file line
  counts, not hunks. That is a deliberate token trade for now, and it means a
  bug visible only in the diff is invisible to the agent.
- **No deploy timeline.** The system correlates against *commit* time, not
  deploy time. In any real pipeline those differ, sometimes by days, and the
  commit that shipped is not the commit that landed.
- **`--no-renames` loses rename information** rather than modelling it. A file
  that moved looks like a delete and an add.

---

## 16. What Phase 3 hands to Phase 4

Not yet anything — nothing writes `correlations` rows. When it does, Phase 4's
root-cause agent gets the incident from Tier 2, the suspected commit from this
tier, and the files implicated within it. That is what turns "the checkout path
is throwing null dereferences" into "this commit added `formatDiscountedPrice`,
which calls `.toFixed` on a column that is NULL for most rows."

The `applied` column on `hypotheses` defaults to false and stays there. The agent
diagnoses; a human decides. That gate was deliberate in Phase 0 and nothing here
changes it.
