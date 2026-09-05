# Phase 4 — Root Cause and Suggested Fix

Phase 3 ends with a `correlations` row naming a commit. This phase reads that
commit's diff and answers the last two questions: **why did it break, and what
should change?**

It is the only stage that writes something a human might act on, and that
changes what it has to guard against.

---

## 1. The funnel narrows a fourth time

```
  every window              → what Tier 1 flagged
  what Tier 1 flagged       → what Tier 2 called real
  what Tier 2 called real   → what Phase 3 correlated
  what Phase 3 correlated   → what it ATTRIBUTED to a commit   ← this stage's own
```

**Only attributed incidents are diagnosed.** A correlation that declined has no
commit, therefore no diff, therefore nothing to reason a fix against.

That is a scoping decision, not an implementation gap, and it is a real
limitation: an incident caused by an upstream dependency or a load change gets
no hypothesis at all. "Diagnose this from logs alone" is a weaker task that Tier
2's summary already half performs, and doing it badly here would dilute the one
thing this stage is for. `pnpm diagnose --stats` shows the shortfall directly —
attributed versus diagnosed.

---

## 2. The diff is mandatory here, and that is the contrast worth understanding

In correlation, hunks are a **measured trade**. They help a capable model rule
commits out and they degrade a weak one, so `CORRELATION_DIFFS` is a switch and
the default is off (`DOCUMENTATION-EVALS.md` §14).

Here there is nothing to trade. The question is *why this change broke* and
*what to change*, and neither half is answerable from a subject line and a line
count. `src/lib/pricing.js +7/-1` cannot produce a patch.

So the diff is always included, and it is the **only packet in this system with
no budget on its largest section**. Every other renderer truncates; a root cause
found in the truncated half is a root cause missed, and this stage runs on at
most one commit for at most one incident. If a commit is large enough for that
to matter, the right answer is a smaller commit.

An unreadable diff is stated as `UNAVAILABLE` rather than rendered as an empty
section — "this commit changed nothing" is a much stronger claim than "the patch
could not be read".

---

## 3. The packet is three things, in causal order

| | |
|---|---|
| **The symptom** | severity, affected area, Tier 2's summary, the detector evidence, and the raw error text |
| **The attribution** | which commit, at what confidence, and the correlator's own reasoning verbatim |
| **The change** | the commit's subject, body, file list and **full diff** |

The correlator's reasoning is passed through deliberately. Without it this stage
would silently re-derive the attribution, and two stages quietly answering the
same question is how a pipeline stops being auditable — the point of separating
them is that each conclusion has one owner.

**That costs something honest:** the model is told what to believe about
causation before it reads the code. Section 4 is the answer to that.

The raw error text is carried again for the same reason the correlation packet
carries it: normalisation is what makes the new-signature detector work and what
makes this stage harder. `reading '<str>'` cannot be matched against a line of
code; `reading 'toFixed'` can.

---

## 4. `explainsTheFailure`, and why the contract changed

`hypothesisSchema` gained a boolean in this phase. It was not in the Phase 0
contract, and adding it is the direct application of what Phase 3 measured:

> a model with no way to decline does not decline — it fabricates.

That is why `suspectedCommitSha` is nullable, and why "declined when it should"
is half the correlation scorecard. The same risk is **sharper here**, because
this stage is handed an attribution and asked to explain it. A stage that can
only agree with its input is not a stage.

`false` does not mean the other fields are empty. `rootCause` should then say
what the diff fails to account for, which is itself a finding — and a
disagreement between Phase 3 and Phase 4 is far more useful than a mechanism
invented to reconcile them.

**This is not hypothetical.** The first real run caught exactly that. The
correlation had been produced by the stub, which blames the newest commit, and
the newest commit was a CI workflow change. `gemini-2.5-flash` read the diff and
returned `explainsTheFailure: false` at 0.95 confidence:

> The provided commit only modifies a GitHub Actions CI workflow file … It does
> not alter any application code that would be deployed to the orders-api
> service, and therefore cannot directly cause a runtime TypeError in the
> production environment.

The field earned its place on its first call.

---

## 5. The prompt

Built around three failures, in order of what they cost:

| Failure | Why it matters |
|---|---|
| **A fix that cannot be checked** | "add error handling", "validate the input" — true of almost any code, actionable for none of it, impossible to review |
| **Agreeing by default** | the packet states which commit was blamed and why |
| **Explaining the error text** | restating "a null was dereferenced" is not a root cause; *why* the value is null is |

The fix must **name the file, the function and the change**, because someone
will read it with the diff open beside it and decide in about a minute. A
paragraph of advice is one they have to re-derive from scratch, at which point
the stage saved nobody anything.

The prompt says explicitly that nothing it writes is applied. That is not
decoration — telling a model its output is a proposal for review changes what it
writes, toward something a reviewer can judge and away from something that reads
as already decided.

Confidence bands are spelled out, same as the other two prompts, for the same
reason: 0.7 means different things to different models.

**Not tuned against an eval.** Written before any model was called with it and
before any Phase 4 golden case exists — the same ordering the classifier and
correlator prompts held to. `prompt.test.ts` enforces that no fixture
identifier, sha or worked example appears in it.

---

## 6. The human gate

`hypotheses.applied` defaults to false. **No code in this repository writes it.**
There is no `--apply` flag, no dashboard button, and no code path that turns a
suggested fix into a change.

`pnpm diagnose --stats` prints the number applied alongside a note that it is
expected to stay zero. If it ever moves, something was added that should have
been argued about first.

---

## 7. The stub declines, deliberately

The stub provider answers `classifier` with a statistical judgement and
`correlator` with "blame the newest commit". Both are real baselines: the thing
you would build without a model, and the thing the tier has to beat.

For `root_cause` it declines. There is no cheap non-model way to derive a
mechanism from a diff — no counting or pattern-matching produces one — so a stub
attempt would be a straw man rather than a control. It returns
`explainsTheFailure: false` with a reasoning that says no model was called,
which keeps the whole pipeline runnable with no API key without inventing a
comparison that would mean nothing.

---

## 8. Files

| File | Lines | Pure? | What |
|---|---|---|---|
| `diagnosis/context.ts` | 164 | **pure** | the packet: symptom, attribution, change |
| `diagnosis/prompt.ts` | 121 | constant | `ROOT_CAUSE_SYSTEM_PROMPT` |
| `diagnosis/diagnose.ts` | 316 | impure | orchestration, persistence, funnel, preview |
| `diagnosis/cli.ts` | 176 | — | `pnpm diagnose` |
| `diagnosis/context.test.ts` | 129 | — | 8 cases |
| `diagnosis/prompt.test.ts` | 68 | — | 6 cases guarding prompt discipline |

`commitBySha` was added to `correlation/git.ts`: one commit with its diff,
fetched by sha rather than re-derived from a lookback. The blamed commit is only
guaranteed to be inside the window Phase 3 happened to use, and that window is
configurable. A sha that has since been rewritten returns null and fails loudly,
rather than producing a confident explanation of a commit that no longer exists.

---

## 9. Verified behaviour

`pnpm typecheck` clean across four packages, **197 tests pass**, up from 163.

End to end against a seeded database:

- `--preview` renders the full packet and calls nothing
- a real run produced a hypothesis, wrote the row, and moved status to `diagnosed`
- re-running reported nothing to do
- `applied` is `0` and the funnel says so
- the dashboard renders the panel, including the disagreement callout

The first real call disagreed with its input, correctly. See §4.

---

## 10. Known limitations

- **Prose quality is not measured, and will not be.** "Is this mechanism right"
  and "is this fix good" need a human or a second model marking the first one's
  homework, and a metric that cannot be trusted is worse than none.

  This section previously said Phase 4 had **no eval at all**, for that reason.
  That was half right and stopped one step too early: `explainsTheFailure` is a
  boolean with a correct value per case, and is scorable for exactly the reason
  `suspectedCommitSha`'s null is. There is now a five-case set built in pairs —
  the same incident attributed once to the guilty commit and once to an innocent
  one — plus a mechanical check that a proposed fix names a file the commit
  actually touched. `DOCUMENTATION-EVALS.md` §16.
- **Incidents with no attributable commit get nothing.** §1.
- **One commit only.** A failure caused by the interaction of two changes cannot
  be expressed, because the correlator names one sha and this stage reads one
  diff.
- **No repository context beyond the diff.** The model sees what changed, not
  the file it changed *into*. A bug that is only visible in the surrounding
  code — a caller three files away, an assumption in a schema — is invisible.
  This is the same limitation correlation has, one level deeper.
- **`suggestedFix` is prose, not a patch.** It names a file and a change; it
  does not produce something applyable, and deliberately so while the human gate
  is the only safeguard.
