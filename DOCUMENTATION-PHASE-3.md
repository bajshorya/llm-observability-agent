# Phase 3 — Commit Correlation (in progress)

Phase 2 ends with rows in `anomalies` that are real, described and prioritised:
`is_real_incident = 1`, a severity, a plain-English summary, an affected area,
and status still `open`. Phase 3 asks the next question — **which commit did
this?**

This document covers what has been built so far: the decision that was blocking
the phase, the target repository, the commit contract, the collector and the
evidence packet. The prompt and the agent itself are **not built**, and no model
has been called. §10 is the honest inventory; §11 is the one decision still
outstanding.

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
see §11.

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

**Both numbers are arguments, not measurements.** Six golden cases cannot tune
them, and tuning them against six cases would mean nothing — the same reasoning
that keeps the classifier prompt unchanged. They are stated in the file header
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

## 8. Files

| File | Lines | Pure? | What |
|---|---|---|---|
| `shared/src/schemas/commit.ts` | 93 | contract | `candidateCommitSchema`, `changedFileSchema`, `commitWindowSchema` |
| `backend/src/correlation/commits.ts` | 214 | **pure** | `GIT_LOG_FORMAT`, `GIT_LOG_ARGS`, `parseGitLog` |
| `backend/src/correlation/git.ts` | 145 | impure | `defaultLookback`, `resolveTargetRepo`, `collectCommits` |
| `backend/src/correlation/context.ts` | 280 | **pure** | `correlationBudget`, `describeAge`, `renderCorrelationContext` |
| `backend/src/correlation/commits.test.ts` | 195 | — | 15 cases, all plain strings |
| `backend/src/correlation/context.test.ts` | 196 | — | 13 cases, all literals |
| `scripts/build-fixture-repo.sh` | 503 | — | the target repository |

Three `git log` flags are worth knowing about, all in `GIT_LOG_ARGS`:

- `--numstat` — per-file line counts. The difference between "this commit
  touched pricing" and "this commit rewrote pricing".
- `--no-renames` — a rename is reported as its real path rather than a
  `{old => new}` expression the parser would have to understand.
- `--no-merges` — merge commits introduce no changes of their own. Offering one
  as a candidate is offering the model a cause that cannot be one.

---

## 9. Verified behaviour

`pnpm typecheck` clean. **109 tests pass**, up from 81 — 15 for the parser and
13 for the packet, and none of them touch a filesystem.

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

**No model has been called yet.** There is no measured correlation accuracy in
this document, and any claim about how well this phase works would be an
assertion. §10 of `DOCUMENTATION-EVALS.md` is what that claim will have to look
like when it exists.

---

## 10. What is not built

| Piece | State |
|---|---|
| Target repository | ✅ Built |
| `candidateCommitSchema` etc. | ✅ Built |
| Commit collector, pure + impure | ✅ Built |
| `correlation/context.ts` — the evidence packet | ✅ Built |
| `correlation/prompt.ts` — `CORRELATOR_SYSTEM_PROMPT` | Not built |
| `correlation/correlate.ts` — orchestration, persistence | Not built |
| `pnpm correlate` CLI | Not built |
| Golden cases for correlation | Not built |
| `correlations` table | Schema exists since Phase 0; nothing writes to it |

The two things the agent will reuse already exist and already work:
`generateStructured` with `correlationSchema`, and a provider layer that has been
exercised against a real model.

The status lifecycle already has the vocabulary too — `open → correlated →
diagnosed` — and nothing has written `correlated` yet.

---

## 11. The open decision, blocking the golden cases

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

## 12. Trade-offs

| Decision | Cost accepted |
|---|---|
| Fixture history authored by us | A critic can say the task was made findable. Mitigated by the decoys and the two `null` cases, not by denial |
| Generated, not committed | A fresh clone must run the script before `pnpm correlate` works |
| Anchor pinned to the capture date | `--anchor now` gives a coherent live demo but different shas, so golden cases and demos cannot share one build |
| 48h / 25 commits | Both unmeasured. A bug that shipped a week before it surfaced is outside the window and will correctly-but-uselessly return `null` |
| `--no-merges` | A squash-merge workflow puts the real change *in* a merge commit. This fixture does not use one; a real repository might |
| Two control characters as framing | Fully defends `\x1f`, only detects `\x1e`. See §5 |

---

## 13. Known limitations

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

## 14. What Phase 3 hands to Phase 4

Not yet anything — nothing writes `correlations` rows. When it does, Phase 4's
root-cause agent gets the incident from Tier 2, the suspected commit from this
tier, and the files implicated within it. That is what turns "the checkout path
is throwing null dereferences" into "this commit added `formatDiscountedPrice`,
which calls `.toFixed` on a column that is NULL for most rows."

The `applied` column on `hypotheses` defaults to false and stays there. The agent
diagnoses; a human decides. That gate was deliberate in Phase 0 and nothing here
changes it.
