# CLAUDE.md

Read this first, then `START-HERE.md`. Do not read the other documents front to
back — they are reference, and there are ~30,000 words of them.

## What this is

An LLM-powered observability agent. Cheap statistics detect anomalies for free;
an LLM reads only the windows the statistics flagged and decides whether they
actually matter. Later phases correlate real incidents with git commits and
propose a fix.

TypeScript, pnpm workspace, three packages: `shared` (Zod contracts),
`generator` (synthetic traffic), `backend` (ingestion, detection, classification,
evals).

## Where to look

| Need | File |
|---|---|
| Orientation, reading order, concept map | `START-HERE.md` |
| Architecture, data model, every source file | `CODEBASE.md` |
| Why a threshold is what it is | `DOCUMENTATION-PHASE-1.md` |
| The LLM layer in depth | `DOCUMENTATION-PHASE-2.md` |
| Commit correlation, and the fixture repo | `DOCUMENTATION-PHASE-3.md` |
| How evaluation works and what it found | `DOCUMENTATION-EVALS.md` |

Every source file also opens with a detailed header explaining what it does and
why. Those are usually faster than the documents.

The phase documents are chronological, so where two disagree the later one wins.
`CODEBASE.md` describes the system as it is now and takes precedence.

## Status

Phases 0–2 are done: ingestion, storage, the three Tier 1 detectors, the LLM
provider layer, the Tier 2 classifier, cost logging, and a golden-set eval
harness.

Phase 3 is **in progress**. Built: the target repository (`scripts/build-fixture-repo.sh`),
the commit contract, the collector, the evidence packet, the prompt and the
orchestration (`backend/src/correlation/`). `pnpm correlate` runs end to end.
Not built: the correlation eval and its golden cases. **There is one observed
run and no measurement**, so the phase has no accuracy figure — see
`DOCUMENTATION-PHASE-3.md` §11–12.

Phases 4 (root-cause agent) and 5 (dashboard) are not built — their tables and
Zod contracts exist, no code.

The two-tier claim is **measured, not asserted**: on `gemini-3.5-flash` the
golden set scores 6/6 on every axis, stably; the statistical baseline scores 0/3
on the benign half. See `DOCUMENTATION-EVALS.md` §10.

## Commands

```bash
pnpm typecheck && pnpm test        # 129 tests, ~300ms, no network
pnpm backend                       # ingestion API on :4000
pnpm generate backfill --minutes 120
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm detect                        # Tier 1 — free, never calls a model
pnpm classify --preview <id>       # the exact prompt, calls nothing
pnpm correlate                     # Phase 3 — which commit, or none
pnpm correlate --preview           # the exact prompt, calls nothing
pnpm eval --provider gemini        # score the golden set

bash scripts/build-fixture-repo.sh # the repo Phase 3 correlates against
```

## Conventions that matter

**Commit messages must not mention Claude, Anthropic, or AI assistance.** No
`Co-Authored-By` trailer. Commits are split into logical chunks with bodies that
explain the reasoning and the trade-off accepted, matching the existing history.

**Pure and impure code are kept apart.** `detectors.ts`, `stats.ts`,
`context.ts`, `structured.ts`, `json.ts`, `grounding.ts`, `score.ts` have no
database, clock or network. `engine.ts`, `rollup.ts`, `classify.ts`, `calls.ts`
own persistence. Keep it that way — it is why the tests need no fixtures.

**Every boundary is validated with Zod.** Nothing downstream consumes
unvalidated data, model output included.

**Tier 1 must never call a model.** `pnpm detect` is free and stays free.
Classification and correlation are each their own command — every stage that
spends quota is an explicit act.

**The stub answers `classifier` and `correlator`, and must keep doing so.** It is
what makes the whole pipeline run with no API key, and it is the baseline each
tier is measured against: statistical judgement for Tier 2, "blame the newest
commit" for Phase 3. Both are deliberately the thing the tier must beat.

**State trade-offs; do not hide them.** Every design-decision table has a costs
column, and limitations are listed rather than omitted.

## Gotchas that will cost you time

**Golden cases are captured artefacts.** They store the rendered prompt as a
fixed string, so ANY change to the evidence packet invalidates all six. Rebuild
with `bash scripts/capture-cases.sh`. It fails loudly if a scenario stops
tripping Tier 1, which would otherwise make a case silently meaningless.

**Gemini free tier is 20 requests a day, bucketed PER MODEL.** A six-case eval
plus any experimentation exhausts one model's budget. When you get a 429, point
`LLM_MODEL` at a different model rather than waiting — the retry hint in the
error is misleading.

**Do not tune the prompt against the eval.** `correlation/prompt.test.ts` now
enforces this for the correlator — it fails if a fixture identifier, a sha or a
worked example appears in the prompt. The classifier prompt has no such guard
and relies on this note.
 Six cases is not enough signal; a
prompt fitted to that set scores well on it and means nothing. The prompt has
been byte-for-byte unchanged since before the first real model run, deliberately,
including through runs that scored badly. Fix evidence and test data instead, and
be able to justify each change without reference to the score it produced.

**The fixture repo is generated, and its shas are load-bearing.**
`fixtures/orders-api` is gitignored — build it with `bash
scripts/build-fixture-repo.sh`. Every date and identity is pinned so the shas
are identical on every run; editing the script changes them, and the null-price
sha is referenced in `generator/src/scenarios.ts`. `--anchor now` deliberately
produces different shas and is for live demos only.

**The lookback is 48h/25 commits and the fixture is built to sit inside it.**
A decoy commit once landed two minutes outside the window and was silently never
offered as a candidate. If you move a fixture commit, check it still appears in
`collectCommits`.

**`pnpm db:push` always writes to `data/dev.db`**, regardless of `DATABASE_URL` —
drizzle-kit runs outside the app's env loading. Scratch databases are made by
copying that schema.

## Open decision, blocking the correlation prompt

**Settled:** Phase 3 correlates against a real git repository built by a script
and gitignored, not an external repo and not a JSON fixture. Reasoning in
`DOCUMENTATION-PHASE-3.md` §2.

**Still open, and it blocks the golden cases rather than the prompt:**
`deploy-restart` emits `orders-api v1.4.2 starting up (deploy
7c1e044)`, and `7c1e044` matches nothing in the fixture. Pointing it at a real
commit would make the strongest `null` test in the set — the log names a real
candidate and the answer is still `null`. But that line is *in the evidence
packet*, so changing it invalidates all six golden cases and moves the capture
window off the fixture's anchor. Current position is to leave it until the
correlator exists and the improvement is measurable. See §13 of the Phase 3
document.
