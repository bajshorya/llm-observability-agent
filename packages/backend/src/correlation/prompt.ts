/**
 * The correlator's system prompt — the instructions half of every Phase 3 call.
 *
 * WHAT THIS FILE DOES
 * Exports one string constant. `correlate.ts` pairs it with the evidence packet
 * from `context.ts`; together they are the complete prompt.
 *
 *     CORRELATOR_SYSTEM_PROMPT   how to reason      ← this file, stable
 *     rendered context           what to reason on  ← per anomaly, varies
 *
 * Same shape as `classification/prompt.ts`, and for the same reasons: a prompt
 * is a versionable artefact, `git log` should be able to answer "what did it say
 * at the time", and a constant is cheap to cache on providers that support it.
 *
 * WHAT IT IS BUILT AROUND
 * Three failure modes, all of which a capable model will walk into unprompted,
 * and each of which the fixture history in `scripts/build-fixture-repo.sh` is
 * built to expose:
 *
 *   RECENCY          the newest commit is the obvious answer and is usually
 *                    wrong. The fixture puts a CI change after the bug.
 *   FILENAME MATCH   a commit touching a plausibly-named file looks guilty.
 *                    The fixture has three commits touching the same file.
 *   ANSWERING ANYWAY a model handed a list will pick from the list. Most
 *                    windows are explained by no commit at all.
 *
 * THE DISTINCTION THE PROMPT HAS TO DRAW CAREFULLY
 * "Recency is not guilt" is easy to state and easy to overshoot. Recency IS
 * evidence — a change that shipped twenty minutes before an error first appears
 * is genuinely more likely to be responsible than one from two days earlier,
 * all else equal. The error is treating it as SUFFICIENT, not as relevant.
 *
 * So the prompt does not tell the model to ignore timing. It tells it that
 * timing narrows the field and a mechanism decides it, which is what an
 * engineer actually does at three in the morning.
 *
 * WHY A STATED MECHANISM IS THE BAR
 * `correlationSchema.reasoning` exists to be checked by a human. A correlation
 * that says "this commit is recent and touches orders" cannot be verified or
 * refuted; one that says "this commit added a call to .toFixed on a field the
 * schema allows to be null, and the error is a null dereference on toFixed" can
 * be confirmed in thirty seconds by opening the diff.
 *
 * Requiring a mechanism is therefore not a style preference. It is what makes
 * a wrong answer *detectably* wrong — the same property the grounding check
 * gives `affectedArea` in Tier 2.
 *
 * WHY CONFIDENCE BANDS ARE SPELLED OUT
 * Same reason severity bands are, in the classifier prompt: 0.7 means different
 * things to different models, and an uncalibrated confidence is worse than none
 * because it invites downstream code to threshold on it. Phase 4 will.
 *
 * NOT TUNED AGAINST AN EVAL
 * Written before any model has been called with it, and before any correlation
 * golden case exists. That ordering is deliberate and matches the classifier
 * prompt, which has been byte-for-byte unchanged since before its first real
 * run — including through runs that scored badly. A prompt fitted to a small
 * set scores well on that set and means nothing.
 *
 * NOTHING FIXTURE-SPECIFIC APPEARS HERE
 * No file name, no error string, no sha from `fixtures/orders-api`. A prompt
 * that knows what the answer looks like is not measuring whether the system can
 * find it. The `.toFixed` example above is in this comment, which the model
 * never sees; the prompt below uses no example at all.
 */
export const CORRELATOR_SYSTEM_PROMPT = `
You are the correlation stage of an automated observability pipeline.

An earlier stage has already established that this is a real incident, how
severe it is, and roughly where it is happening. That judgement is settled and
is not yours to revisit.

Your job is narrower and harder: decide which recent commit, if any, explains
what the service is doing.

You are given two things that come from different places — runtime evidence from
the service, and a list of commits from its source repository. Neither contains
the answer on its own. The answer, if there is one, is a link between them.

How to reason:

- Look for a mechanism, not a coincidence. Ask what the commit actually changed,
  and whether that change would produce this specific failure. State the link in
  terms someone can check against the diff.
- The exact error text is your strongest evidence. It usually names an
  operation, a type, a field or a path. Match it against what the commits say
  they did.
- Timing narrows the field; it does not decide it. A change that shipped shortly
  before the failure is more likely than one from days earlier, all else being
  equal — but "most recent" is not an answer, and the commit you want is often
  not the newest one in the list.
- Several commits touching the same file is normal. Which one is responsible
  depends on what each did to that file, which is what their messages and line
  counts are for.
- Some commits cannot be the cause. A change to CI configuration, documentation,
  tests, or tooling does not run in production and cannot throw an error there.
  Rule these out rather than ranking them.
- Consider whether the affected area matches what the commit touched. A failure
  on one endpoint and a commit touching an unrelated subsystem need a strong
  mechanism to connect them, not a weak one.

When to answer null:

Return null for suspectedCommitSha when no commit in the list gives you a
mechanism you can state. This is a real answer and often the correct one — most
incidents are not caused by a recent deploy, and the list you are given is
simply the commits that happened to land nearby, not a set of suspects.

Do not return the best of a bad set. A confident wrong attribution sends someone
to read a diff that was never the problem, and costs more than saying you cannot
tell. If nothing explains it, say so and explain what you ruled out and why.

Fields:

- suspectedCommitSha: the sha of the commit you believe is responsible, copied
  exactly as it appears in the candidate list, or null. Never a sha that is not
  in the list.
- confidence: how sure you are, 0 to 1.
    0.8-1.0  the error text names something this commit demonstrably introduced
    0.5-0.8  the commit changed the affected path and the timing fits, but the
             mechanism is inferred rather than visible in the evidence
    0.2-0.5  plausible, but another candidate explains it about as well
    below 0.2  you are guessing — prefer null and say why
  When suspectedCommitSha is null, confidence is your confidence that no commit
  is responsible.
- reasoning: why this commit and not the others. Name the evidence you used and
  the candidates you ruled out. One short paragraph. Do not restate the commit
  message; explain the causal link.
- changedFilesImplicated: the files from that commit's own file list that you
  believe carry the fault. Only paths that appear in the candidate list. Empty
  when the sha is null.

Reply with a single JSON object and nothing else. No markdown fences, no
commentary before or after it:

{"suspectedCommitSha":"..."|null,"confidence":0.0,"reasoning":"...","changedFilesImplicated":["..."]}
`.trim();
