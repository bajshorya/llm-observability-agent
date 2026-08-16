# Start Here

There are ~30,000 words of documentation in this repo for ~4,900 lines of code.
**Do not read them in order.** They are reference material — written to be
searched when you have a specific question, the way you use a man page.

This file is the only one meant to be read front to back. Fifteen minutes here
and you will understand the system; everything else is lookup.

---

## The system in one screen

A monitored app posts logs. Cheap statistics find anomalies for free. An LLM
reads only the windows statistics flagged, and decides whether they actually
matter. Later phases will correlate the survivors with git commits and propose a
fix.

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
                                    ├── real     ──▶ stays open, Phase 3 correlates commits
                                    └── benign   ──▶ dismissed
```

The funnel is the whole point. Tier 1 is free and can run every 30 seconds.
Tier 2 costs quota, so it only ever sees what Tier 1 raised — and because
repeated firings of one incident merge into a single anomaly row, one incident
costs one model call, not one per detection run.

---

## Five ideas that explain almost every decision

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
`classify.ts`, `calls.ts`. That split is why 81 tests run in 300ms with no
fixtures. **When you are hunting for logic, it is in a pure file.**

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

---

## The code map

Faster than the docs for most questions. The whole system is 4,900 lines.

```
packages/shared/        The contract. Zod schemas + signature normalisation.
                        Read schemas/ first — it defines every shape in the system.

packages/generator/     Synthetic traffic. scenarios.ts holds all six scenarios;
                        three are real incidents, three should be dismissed.

packages/backend/src/
  routes/ingest.ts      Validate and persist. Deliberately dumb.
  db/schema.ts          All six tables in one file, with comments.
  detection/            config.ts (every threshold + why) · detectors.ts (pure)
                        rollup.ts + engine.ts (database)
  llm/                  types.ts is the whole provider contract (one method).
                        structured.ts is the repair loop. providers/ is one file each.
  classification/       context.ts builds what the model sees · prompt.ts is the
                        prompt · classify.ts orchestrates
  eval/                 Golden set: cases/, grounding.ts, score.ts
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
| What is known to be broken? | `CODEBASE.md` §19 — consolidated |
| What is next? | `PHASE-2` §18 |

(`PHASE-1` = `DOCUMENTATION-PHASE-1.md`, and so on.)

---

## The fifteen-minute path

1. **README**, top through the Tier 2 section. Skip the rest. *(5 min)*
2. **The five ideas above.** *(3 min)*
3. **Run it** — this teaches more than any prose: *(7 min)*

```bash
pnpm backend                                   # terminal 1
pnpm generate backfill --minutes 120           # terminal 2
pnpm detect                                    # → clean
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm detect                                    # → ANOMALY, two triggers fired
pnpm classify --preview <anomaly-id>           # ← the single most useful command
```

That last command prints the exact prompt the system sends. Seeing the evidence
packet — the triggers in words, the signature counts, the sampled log lines —
explains the design better than §6 of any document.

Then stop. Come back to the table above when you have a real question.

---

## When two documents disagree

The reference docs are **phase-ordered**, so each one describes the system as it
stood at the end of that phase. Some of what they say has since been superseded.

**The rule: the code and the README are current. Between two docs, the later one
wins.**

Known instances:

- `PHASE-1` §16 says anomalies are never dismissed and stay `open`. Phase 2
  changed that — see `PHASE-2` §9 and §10.
- `PHASE-1` says 27 unit tests. There are now 81.
- `PHASE-2` §6 describes the log sample as drawn evenly across the window. It is
  now drawn by message shape — see `EVALS` §4, which explains why the original
  approach silently dropped the one line that explained a benign window.
- `PHASE-2` §6 and `EVALS` §3 describe an evidence packet with no per-minute
  timeline and no per-endpoint breakdown. Both were added later; `CODEBASE.md`
  §13 and `EVALS` §9 are current.

This is the cost of chronological documentation, and it is worth knowing about
before it misleads you.

---

## If you only remember one thing

Cheap statistics filter; the model reads. Everything else — the separate
commands, the offline stub, the merge rule, the budgeted context, the eval
harness — exists to keep that split honest and to prove it works.

Whether it *does* work now has a partial measured answer: `EVALS` §8–10. Gemini
dismisses the hardest benign case that the statistics cannot; the final evidence
packet is only one-sixth measured because the free tier allows 20 requests a day.
Along the way the eval found that two of the six labels were wrong — which is
the most useful thing it has done so far.
