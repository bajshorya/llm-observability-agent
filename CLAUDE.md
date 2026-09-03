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

Phase 3 is **done and measured** on a six-case set (two attributable, four
declines for four different reasons). `gemini-2.5-flash` scores 2/2 and 4/4;
`llama3.2` names the same commit to every case and scores 0/4 on declining; the
"blame the newest commit" baseline scores 0/2 and 0/4. **A single run is a
sample** — the same model scored 1/4 declining on the previous capture, and
repeatability is untested. `DOCUMENTATION-EVALS.md` §14.

Phases 4 (root-cause agent) and 5 (dashboard) are not built.

The two-tier claim is **measured, not asserted**: on `gemini-3.5-flash` the
golden set scores 6/6 on every axis, stably; the statistical baseline scores 0/3
on the benign half. See `DOCUMENTATION-EVALS.md` §10.

## Commands

```bash
pnpm typecheck && pnpm test        # 162 tests, ~300ms, no network
pnpm backend                       # ingestion API on :4000
pnpm generate backfill --minutes 120
pnpm generate inject --scenario deploy-restart --minutes 5
pnpm detect                        # Tier 1 — free, never calls a model
pnpm classify --preview <id>       # the exact prompt, calls nothing
pnpm correlate                     # Phase 3 — which commit, or none
pnpm correlate --preview           # the exact prompt, calls nothing
pnpm eval --provider gemini        # score the classifier golden set
pnpm eval --correlation            # score the correlation set (4 cases)
LLM_MODEL=llama3.2 pnpm eval --correlation --provider ollama   # free, local, no quota

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

**Correlation cases pin Tier 2's verdict — do not make capture call the
classifier again.** A packet embeds the verdict, and re-deriving it from a model
per capture made the set's difficulty drift: `latency-jump` failed on three
models in one capture and passed on two in the next with no packet change. The
verdict now lives in `src/eval/verdicts/<scenario>.json` and capture reads it,
which is also why capture makes no model calls. Re-pin deliberately, from a real
run, and expect scores to move when you do.

**Hunks in the correlation packet are built but OFF.** `{ diffs: true }`, or
`--diff` on capture. A controlled A/B did not support turning them on: one
regression, no reproducible benefit, 3.7× packet growth. Do not switch the
default without a bigger and more stable golden set. `DOCUMENTATION-EVALS.md` §14.

**A decline case is only as good as the absence of a plausible culprit, and
"plausible" is judged from the packet, not the source tree.** `orphan-refund-bug`
originally named `created_at` in its error, and a model correctly reasoned that
the commit changing `created_at` formatting could cause it. The scenario was
changed, not the label. Check a new decline case's error text against every
commit in the window before pinning it.

**Golden cases are captured artefacts.** They store the rendered prompt as a
fixed string, so ANY change to the evidence packet invalidates all six. Rebuild
with `bash scripts/capture-cases.sh`. It fails loudly if a scenario stops
tripping Tier 1, which would otherwise make a case silently meaningless.

**Ollama's configured default is `llama3.1:8b`, which may not be installed.**
`ollama list` shows what is; override with `LLM_MODEL`. The eval counts a
missing model as "no valid answer" rather than a wrong answer, which is correct
but easy to misread as the model scoring zero.

**Gemini free tier is 20 requests a day, bucketed PER MODEL.** A six-case eval
plus any experimentation exhausts one model's budget. When you get a 429, point
`LLM_MODEL` at a different model rather than waiting — the retry hint in the
error is misleading.

**Do not tune the prompt against the eval.** This has already been tested once,
and holding the line paid. The correlation eval exposed a repeatable failure
(`latency-jump`) that a prompt edit would plausibly have fixed. Instead of
editing, the same cases were run against two more models — all three failed
identically, which located the problem in the EVIDENCE (no diff content, so an
innocent commit cannot be exonerated) rather than the instructions. A prompt
patch would have papered over that and scored better. `DOCUMENTATION-EVALS.md`
§14.
`correlation/prompt.test.ts` also enforces this mechanically for the correlator — it fails if a fixture identifier, a sha or a
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
