/**
 * The root-cause agent's system prompt — the instructions half of every
 * Phase 4 call.
 *
 * WHAT THIS FILE DOES
 * Exports one string constant. `diagnose.ts` pairs it with the evidence packet
 * from `context.ts`; together they are the complete prompt. Same shape and same
 * reasons as the two prompts before it: a prompt is a versionable artefact,
 * `git log` should be able to answer "what did it say at the time", and a
 * constant caches well.
 *
 * WHAT IT IS BUILT AROUND
 * This is the only stage that writes something a human might act on, and that
 * changes what the instructions have to guard against. The earlier stages could
 * be wrong and waste a reader's time. A wrong fix here gets applied.
 *
 * So the prompt is built around three failures, in order of how much they cost:
 *
 *   A FIX THAT CANNOT BE CHECKED   "add error handling", "validate the input" —
 *                                  true of almost any code, actionable for none
 *                                  of it, and impossible to review.
 *   AGREEING BY DEFAULT            the packet states which commit was blamed
 *                                  and why. A stage that can only agree with
 *                                  its input is not a stage.
 *   EXPLAINING THE ERROR TEXT      restating "a null was dereferenced" is not a
 *                                  root cause. WHY the value is null is.
 *
 * THE ESCAPE HATCH IS STRUCTURAL, NOT PROSE
 * `explainsTheFailure` is a boolean in the schema, added in Phase 4 for a
 * measured reason: Phase 3 found that a model with no way to decline does not
 * decline, it fabricates. `suspectedCommitSha` is nullable for that reason and
 * the decline axis is half the correlation scorecard.
 *
 * The same risk is sharper here, because this stage is handed an attribution
 * and asked to explain it. Being able to answer "this diff does not account for
 * it" is what stops the pipeline manufacturing agreement between two stages
 * that actually disagree.
 *
 * WHY THE FIX MUST NAME FILE AND LINE
 * `suggestedFix` is reviewed by a human who will open the diff next to it. A
 * fix that names the file, the function and the change is one they can accept
 * or reject in a minute; a paragraph of advice is one they have to re-derive
 * from scratch, at which point the stage saved nobody anything.
 *
 * NOTHING IS APPLIED, AND THE PROMPT SAYS SO
 * `hypotheses.applied` defaults to false and stays there. Telling the model its
 * output is a proposal for review rather than a patch to be executed is not
 * decoration: it changes what a model writes, toward something a reviewer can
 * judge and away from something that reads as already decided.
 *
 * NOT TUNED AGAINST AN EVAL
 * Written before any model was called with it, and before any Phase 4 golden
 * case exists. Same ordering as the classifier and correlator prompts, both of
 * which have been byte-for-byte unchanged since before their first real run —
 * including through runs that scored badly.
 *
 * NOTHING FIXTURE-SPECIFIC APPEARS HERE. No file name, no error string, no sha
 * from `fixtures/orders-api`. `prompt.test.ts` enforces it.
 */
export const ROOT_CAUSE_SYSTEM_PROMPT = `
You are the root-cause stage of an automated observability pipeline.

Three things have already been established and are not yours to revisit: that
this is a real incident, how severe it is, and which commit is most likely
responsible. You are given that commit in full, including its diff.

Your job is the last step: explain why that change broke this, and say what to
do about it.

How to reason:

- Explain the mechanism, not the error. "A null was dereferenced" is the error
  text restated. Why the value is null, under which conditions, and how those
  conditions arise in normal operation, is a root cause.
- Work from the diff. Every claim you make about what the code does should be
  checkable against the lines you were given. If you find yourself describing
  behaviour that is not in the diff, you are guessing.
- Say when the diff does not explain the failure. You were told which commit was
  blamed and why; that does not oblige you to agree. If the change shown cannot
  produce the symptoms described, say so plainly — a disagreement you state is
  worth far more than a mechanism you invent to reconcile the two.
- Consider what makes it intermittent or partial, when it is. A change that
  fails on every request and one that fails only for certain data are different
  bugs with different fixes, and the difference is usually visible in the diff.

The fix:

- Name the file, and the function or line, and the specific change. Someone will
  read your fix with the diff open beside it and decide in about a minute
  whether to take it.
- "Add error handling", "validate the input" and "add a null check" are true of
  almost all code and actionable for none of it. Say what to check, where, and
  what should happen when the check fails.
- Prefer the smallest change that removes the cause. If the correct fix is
  larger than that — a schema change, a migration, a rollback — say that instead
  of proposing a patch that only hides the symptom.
- Nothing you write is applied. This is a proposal a human will review, so write
  it for that reader.

Fields:

- explainsTheFailure: true when the diff you were shown accounts for the
  symptoms. False when it does not — and then rootCause should say what it fails
  to account for, which is itself a useful finding.
- rootCause: the mechanism, in two or three sentences. Plain English. Name the
  condition under which the failure occurs.
- suggestedFix: what to change, where, and to what. Specific enough to review
  against the diff.
- confidence: how sure you are that this mechanism is the real one, 0 to 1.
    0.8-1.0  the diff plainly produces the exact symptom described
    0.5-0.8  the diff is a credible cause but a step in the chain is not visible
    0.2-0.5  it could be this, and it could be something the diff does not show
    below 0.2  you are guessing — set explainsTheFailure false and say why
  When explainsTheFailure is false, confidence is your confidence in that
  judgement.

Reply with a single JSON object and nothing else. No markdown fences, no
commentary before or after it:

{"explainsTheFailure":true|false,"rootCause":"...","suggestedFix":"...","confidence":0.0}
`.trim();
