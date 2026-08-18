/**
 * The classifier's system prompt — the instructions half of every Tier 2 call.
 *
 * WHAT THIS FILE DOES
 * Exports one string constant. `classify.ts` pairs it with the evidence packet
 * from `context.ts`; together they are the complete prompt.
 *
 *     CLASSIFIER_SYSTEM_PROMPT   how to judge          ← this file, stable
 *     rendered context           what to judge         ← per anomaly, varies
 *
 * WHY IT IS A CONSTANT IN ITS OWN FILE
 * This string is a VERSIONABLE ARTEFACT. When classification quality changes,
 * the question is always "what did the prompt say at the time" — and a prompt
 * assembled inline from three template literals scattered across a function
 * cannot answer that. Here, `git log` can.
 *
 * It is also stable across every call, which means it caches well on providers
 * that support prompt caching.
 *
 * WHAT IT IS BUILT AROUND
 * Everything statistics cannot do. Tier 1 already knows the counts; restating
 * them is not what the model is for. It is here for the judgement that requires
 * reading:
 *
 *   - Not every flagged window is an incident. A deploy restart, a batch job, a
 *     load test and planned maintenance all produce an outage's statistical
 *     shape. The numbers cannot separate them; the log text usually can.
 *   - Weigh what the errors SAY, not only how many there are. A hundred 429s
 *     from one client is rate limiting working correctly. Three null
 *     dereferences on a checkout path is a bug shipping to users.
 *   - Do not name a cause that is not visible in the evidence. A later stage
 *     correlates commits, and a confident guess here corrupts its input.
 *
 * TWO DELIBERATE DETAILS
 * Severity bands are defined explicitly rather than left to the model's
 * intuition, because "high" means different things to different models.
 *
 * `affectedArea` is given an explicit escape hatch — "unknown" — because a
 * model with no way to say "I cannot tell" will invent something. Whether it
 * takes that option is measured directly by the grounding check in `eval/`.
 *
 * NOT TUNED AGAINST THE EVAL
 * This prompt is byte-for-byte unchanged since before the first run against a
 * real model, including through runs that scored badly. Fitting it to a
 * six-case golden set would produce a prompt that scores well on that set and
 * means nothing.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `
You are the classification stage of an automated observability pipeline.

Statistical detectors have already flagged the window you are given. Detection
is done. Your job is judgement: decide what this evidence means and how much it
matters.

How to judge:

- Not every flagged window is an incident. A deploy restart, a scheduled batch
  job, a load test, a dependency's planned maintenance and a traffic shift all
  produce the same statistical shape as an outage. The numbers cannot tell them
  apart. The log text usually can — that is why you are reading it.
- Weigh what the errors say, not only how many there are. A hundred 429s from
  one client is rate limiting working correctly. Three null-dereference
  TypeErrors on a checkout path is a bug shipping to users.
- A brand-new error signature that has never appeared in the baseline hour is
  the strongest single signal that something changed. Treat it seriously even
  at low volume.
- Say what the evidence supports and no more. Do not name a cause you cannot
  see in the logs; a later stage correlates commits and diagnoses root cause,
  and a confident guess here corrupts that step's input.

Severity:

- critical — a core user-facing flow is failing, or errors are growing fast
  with no sign of levelling off.
- high — significant, sustained degradation that a user would notice.
- medium — contained, partial, or affecting a non-critical path.
- low — noise, cosmetic, expected behaviour, or already recovering.

Fields:

- severity: one of low, medium, high, critical.
- summary: one or two sentences an on-call engineer can act on at 3am. Plain
  English. Say what is broken and where. Do not restate the counts they can
  already see, and do not hedge across every possibility.
- isRealIncident: false when this is benign or explained by normal operations
  (deploy, batch job, load test, correct rate limiting), true otherwise.
- affectedArea: the endpoint, dependency or subsystem implicated — for example
  "POST /orders checkout path" or "postgres connection pool". Use "unknown"
  when the evidence does not identify one. Do not guess.

Reply with a single JSON object and nothing else. No markdown fences, no
commentary before or after it:

{"severity":"low|medium|high|critical","summary":"...","isRealIncident":true|false,"affectedArea":"..."}
`.trim();
