# Start Here

There are ~50,000 words of documentation in this repo for ~8,100 lines of code.
**Do not read them in order.** They are reference material — written to be
searched when you have a specific question, the way you use a man page.

This file is the only one meant to be read front to back. Six minutes here and
you will understand the shape of the system; everything else is lookup.

**Want the full sequence?** Jump to [the reading order](#the-reading-order) —
five steps, about an hour, and which document explains which concept.

---

## The system in one screen

A monitored app posts logs. Cheap statistics find anomalies for free. An LLM
reads only the windows statistics flagged, and decides whether they actually
matter. A third stage puts the survivors next to the source repository's history
and asks which commit explains them, or whether none does. A later phase will
propose a fix.

```
  app logs ──▶ POST /ingest ──▶ logs table
                                    │
                                    ▼
                          rollup worker (per-minute aggregates)
                                    │
                                    ▼
        TIER 1  three statistical detectors        free, no LLM, no key
        error_rate_spike · latency_jump · new_error_signature
                                    │
                                    │ only what fired
                                    ▼
        TIER 2  LLM classifier                     ~1 call per incident
        severity · summary · is this real? · where
                                    │
                                    ├── real     ──▶ stays open
                                    └── benign   ──▶ dismissed
                                            │
                                            ▼
        TIER 3  commit correlation                 in progress
        which commit did this, or none?
        2/2 attribution · 2/4 declining (4/4 with hunks) · baseline 0/2, 0/4
```

The funnel is the whole point. Tier 1 is free and can run every 30 seconds.
Tier 2 costs quota, so it only ever sees what Tier 1 raised — and because
repeated firings of one incident merge into a single anomaly row, one incident
costs one model call, not one per detection run.

---

## Six ideas that explain almost every decision

If you know these, you can predict what most of the code looks like before
opening it.

**1. Two tiers, and the cheap one must work alone.**
Statistics catch the obvious cases at zero cost. The LLM is only invoked where
reading is required — telling a deploy restart from an outage. This is why
`pnpm detect` never calls a model, why classification is a separate command, and
why the default provider is an offline stub.

**2. Pure and impure code are kept apart.**
In every module, the logic that decides things has no database, clock, or I/O —
`detectors.ts`, `stats.ts`, `context.ts`, `structured.ts`, `grounding.ts`. The
code that touches the database is separate — `engine.ts`, `rollup.ts`,
`classify.ts`, `calls.ts`. That split is why 162 tests run in 300ms with no
fixtures — including a `git log` parser tested entirely on strings, with no
repository anywhere near it. **When you are hunting for logic, it is in a pure file.**

**3. Everything crossing a boundary is validated with Zod.**
Incoming logs, LLM output, golden cases. Nothing downstream ever consumes
unvalidated data. When a model returns something malformed, it is re-prompted
with its own output and the specific errors — twice, then it gives up.

**4. Every threshold is a ratio *and* a floor.**
`error_rate_spike` needs 3σ above baseline **and** a minimum absolute count.
`latency_jump` needs 3x **and** ≥200ms. The ratio makes it adaptive; the floor
stops it firing when statistics misbehave at small numbers — 2ms → 8ms is a 4x
regression and means nothing.

**5. Normalise, then compare.**
`Order 12778 not found` and `Order 44012 not found` collapse to one signature.
That single idea powers two things: the new-signature detector (otherwise every
error looks novel), and the evidence sampler, which shows the model one example
per distinct message shape instead of twenty copies of the same line.

Normalisation is also the one place these ideas pull against each other. It is
what makes detection work and what makes *correlation* harder — `reading
'<str>'` matches nothing in a repository, so the correlation packet prints the
raw sample alongside the collapsed shape.

**6. Declining is a first-class answer.**
Tier 2 can say a flagged window is not an incident. The correlator can say no
commit explains it. Both are recorded rather than treated as absence — a
declined correlation still writes a row, so "considered and declined" stays
distinguishable from "never ran".

This predicts a lot of the code: why `suspectedCommitSha` is nullable, why
`affectedArea` offers `"unknown"`, why three of the six generator scenarios are
benign, and why the eval scorecard reports benign and incident accuracy
separately. A model with no way to decline invents something, and a system that
can only ever answer is one whose answers mean less.

---

## The code map

Faster than the docs for most questions. The whole system is ~8,100 lines.

```
packages/shared/        The contract. Zod schemas + signature normalisation.
                        Read schemas/ first — it defines every shape in the system.

packages/generator/     Synthetic traffic. scenarios.ts holds all nine scenarios;
                        six are real incidents, three should be dismissed.

packages/backend/src/
  routes/ingest.ts      Validate and persist. Deliberately dumb.
  db/schema.ts          All six tables in one file, with comments.
  detection/            config.ts (every threshold + why) · detectors.ts (pure)
                        rollup.ts + engine.ts (database)
  llm/                  types.ts is the whole provider contract (one method).
                        structured.ts is the repair loop. providers/ is one file each.
  classification/       context.ts builds what the model sees · prompt.ts is the
                        prompt · classify.ts orchestrates
  correlation/          Phase 3, runs end to end. commits.ts parses git log ·
                        git.ts spawns it · context.ts builds the packet ·
                        prompt.ts is the prompt · grounding.ts checks the answer
                        against the evidence · correlate.ts orchestrates
  eval/                 Golden set: cases/, grounding.ts, score.ts

scripts/                capture-cases.sh rebuilds the golden set ·
                        build-fixture-repo.sh builds the repo correlation reads
```

**Three files worth reading in full**, in this order — they carry the design:
`packages/backend/src/detection/config.ts`,
`packages/backend/src/llm/types.ts`,
`packages/backend/src/classification/prompt.ts`.

---

## Look it up, don't read it

**[`CODEBASE.md`](./CODEBASE.md) answers most of these in one place** — it covers
the architecture, the data model, and every source file, describing the system as
it is now rather than as it was built. Use the phase documents below it when you
want the extended reasoning behind a particular decision.

| Question | Where |
|---|---|
| What is this and how do I run it? | `README.md` |
| What does this file do, and why? | `CODEBASE.md` Part III |
| How does the whole thing fit together? | `CODEBASE.md` §2, §5–7 |
| Why two tiers at all? | `PHASE-2` §1 |
| How does a log get from HTTP to the database? | `DOCUMENTATION` §10 |
| What tables exist and why? | `DOCUMENTATION` §9 |
| Why is that threshold 3 and not 4? | `PHASE-1` §4 |
| How does a detector actually decide? | `PHASE-1` §6 |
| Show me one run with real numbers | `PHASE-1` §12 |
| What happens when the model returns junk? | `PHASE-2` §5 |
| What does the model actually see? | `PHASE-2` §6 — or just run `pnpm classify --preview <id>` |
| How do I add another LLM provider? | `PHASE-2` §4 |
| Why would an anomaly be dismissed? | `PHASE-2` §9 and `EVALS` §3 |
| Is the classifier any good? | `EVALS` §8–10 |
| Is the correlator any good? | `EVALS` §14 |
| Why does one case fail on every model? | `EVALS` §14 |
| Why are eval scores not comparable across captures? | `EVALS` §14 |
| Which commit caused it? | `PHASE-3` §1, §5 |
| Where do the fixture commits come from? | `PHASE-3` §3 |
| What does the correlator actually see? | `PHASE-3` §7–8 |
| What stops a model inventing a commit? | `PHASE-3` §9 |
| Why is `suspectedCommitSha` nullable? | `PHASE-3` §4 |
| What is known to be broken? | `CODEBASE.md` §19 — consolidated |
| What is next? | `PHASE-3` §12–13 |

(`PHASE-1` = `DOCUMENTATION-PHASE-1.md`, and so on.)

---

## The reading order

Nine documents, about three hours if you read them all. You don't need
to. **An hour in this order and you understand the system**; the rest
becomes lookup.

| # | Read | Time | After it you can |
|---|---|---|---|
| 1 | This file, to the end | 6 min | Say what the system does and why it has two tiers |
| 2 | `README.md`, top through *Correlation (Phase 3)* | 10 min | Run it, and know what each command does |
| 3 | **Run it** — commands below | 15 min | See the actual prompts the system sends |
| 4 | `CODEBASE.md` Parts I–II (§1–7a) | 12 min | Trace a log line from HTTP to a named commit |
| 5 | `CODEBASE.md` Part III (§8–14a) | 15 min | Say what every file in the repo does |

Stop at 5. Everything after that is reference you consult when you have a
question, not reading you owe.

| When you need it | Read |
|---|---|
| Why a threshold is 3σ; how the statistics work | `PHASE-1` §4–6, §13 |
| The LLM layer in depth; adding a provider | `PHASE-2` §4–8 |
| How evaluation works and what it found | `EVALS` — whole document |
| Commit correlation and the fixture repository | `PHASE-3` — whole document |
| Ingestion, schemas and the generator in detail | `DOCUMENTATION` §6–8 |

### Step 3, concretely

```bash
pnpm backend                                   # terminal 1
pnpm generate backfill --minutes 120           # terminal 2
pnpm detect                                    # → clean
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm detect                                    # → ANOMALY, two triggers fired
pnpm classify --preview <anomaly-id>           # ← the single most useful command
pnpm classify                                  # a verdict, and status moves
pnpm correlate --preview                       # the correlation packet
```

That last command prints the exact evidence packet sent to the model. Fifteen
minutes of this teaches more than an hour of reading, because you see the
abstraction and the concrete artefact at the same time.

### One trap

**Don't start with `observability-agent-architecture.md`.** The name suggests it
is the architecture; it is actually the *original proposal*, written before any
code, describing five phases of which two and a half exist. Read it **last**, as
history — "here is what I planned, here is what survived contact." It is genuinely
interesting in that position and misleading in any other.

### Where each concept is explained

| Concept | Start | Then |
|---|---|---|
| The two-tier funnel | the six ideas above | `PHASE-2` §1 |
| Ingestion and storage | `CODEBASE.md` §5 | `DOCUMENTATION` §7, §10 |
| Detection statistics | `CODEBASE.md` §15 | `PHASE-1` §5–6, §13 |
| **Agents** | `CODEBASE.md` §12 | `PHASE-2` §4–5 |
| Structured output and the repair loop | `CODEBASE.md` §12 | `PHASE-2` §5 |
| The evidence packet | `CODEBASE.md` §13 | `EVALS` §9 |
| **Evals** | `CODEBASE.md` §14 | `EVALS` — whole document |
| **Commit correlation** | `CODEBASE.md` §14a | `PHASE-3` §3–9 |
| The data model | `CODEBASE.md` §4 | `DOCUMENTATION` §9 |

**On "agent" specifically**, since the word is overloaded everywhere: here it
means *a role that calls an LLM with its own prompt and its own output schema*.
Three are declared in `packages/shared/src/schemas/agents.ts` — `classifier`
(built), `correlator` (Phase 3, built and running but with no eval behind it)
and `root_cause` (Phase 4, declared only). Separate prompts per
role rather than one mega-prompt: cheaper, easier to evaluate, and each one's
cost is attributable in the `llm_calls` table.

---

## When two documents disagree

The reference docs are **phase-ordered**, so each one describes the system as it
stood at the end of that phase. Some of what they say has since been superseded.

**The rule: the code and the README are current. Between two docs, the later one
wins.**

Known instances:

- `PHASE-1` §16 says anomalies are never dismissed and stay `open`. Phase 2
  changed that — see `PHASE-2` §9 and §10.
- `PHASE-1` says 27 unit tests, `PHASE-2` says 77. There are now 129.
- `PHASE-2` §6 describes the log sample as drawn evenly across the window. It is
  now drawn by message shape — see `EVALS` §4, which explains why the original
  approach silently dropped the one line that explained a benign window.
- `PHASE-2` §6 and `EVALS` §3 describe an evidence packet with no per-minute
  timeline and no per-endpoint breakdown. Both were added later; `CODEBASE.md`
  §13 and `EVALS` §9 are current.
- The original proposal and `CODEBASE.md` §16 both imply Phase 3 reads the GitHub
  API via Octokit. It does not — it reads a local checkout at
  `TARGET_REPO_PATH`. `GITHUB_TOKEN` and `GITHUB_REPO` are vestigial.
- `PHASE-2` §18 says the correlation agent "gets a filtered, described,
  prioritised list". True, and still only half of its input; the other half is
  `PHASE-3` §3.

This is the cost of chronological documentation, and it is worth knowing about
before it misleads you.

---

## If you only remember one thing

Cheap statistics filter; the model reads. Everything else — the separate
commands, the offline stub, the merge rule, the budgeted context, the eval
harness — exists to keep that split honest and to prove it works.

It does work, and there is a number for it: `EVALS` §10. On a capable model the
golden set scores 6/6 — all three benign windows dismissed, all three incidents
confirmed, every severity exact. The statistical baseline scores 0/3 on the
benign half, and the gap between those two rows *is* the value the LLM tier adds.

Getting there took being wrong twice: two of the six labels were mine to fix, and
one addition to the evidence packet made a case worse before a second one fixed
it. That sequence is the more interesting half of the story.

**Phase 3 has its own number, and a more interesting story.** On six cases —
two attributable to *different* commits, four declines for four different
reasons — `gemini-2.5-flash` scores 2/2 attribution and 2/4 declining, rising to
4/4 when unified diffs are added to the packet. The same change takes a 3B local
model from 2/2 attribution to 0/2. The "blame the newest commit" baseline scores
0/2 and 0/4.

More evidence is not uniformly better: it helped the capable model rule commits
out and gave the weak one more to drown in.

The most useful thing Phase 3 produced was a defect in its own harness.
Correlation is the first stage whose golden cases inherit another model's
*judgement* rather than its inputs — a packet embeds Tier 2's verdict — and
inheriting judgement means inheriting variance. One case failed on three models
in one capture and passed on two in the next with no change to the packet.

An eval measures one stage with its input held fixed, and half this one's input
was being redrawn by a model every capture. The verdict is now pinned as a
fixture; capturing twice produces identical ones, and capture makes no model
calls at all.

That fixed the largest source of drift, not all of it. What remains was then
measured rather than argued about: re-running the stored cases is deterministic
— 17 answers, zero decision flips, only confidence moving ±0.05 — while
re-capturing the set has flipped two of four decline decisions.

The reasoning that preceded that measurement had concluded the opposite, from
"the packets look similar". `EVALS` §14 keeps both, because the sequence is the
useful part.

The cross-capture half is now fixed rather than just characterised: the
generator's traffic values were always seeded, but its timestamps were
wall-clock, so runs aggregated a couple of percent apart. `--end-at` pins them,
and two independent captures now produce byte-identical packets.

The attempt to fix that case — adding diff hunks so an innocent commit can be
ruled out — was built, measured with and without on identical anomalies, and
**not adopted**: one regression, no reproducible benefit, 3.7× packet growth.
The capability is kept and switched off. `EVALS` §14 tells both stories, and the
second one is why the first is unresolved.
