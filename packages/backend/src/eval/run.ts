/**
 * Running the golden set through a provider.
 *
 * WHAT THIS FILE DOES
 * Iterates the cases, sends each through the real `generateStructured` with the
 * real system prompt, scores the result, and returns per-case scores plus a
 * summary. The impure half of the eval — `score.ts` and `grounding.ts` hold the
 * rules, this holds the calls.
 *
 * IT MEASURES THE PIPELINE, NOT A RECONSTRUCTION OF IT
 * Every case goes through the same code path a real classification does,
 * including the repair loop — which is itself part of what a provider is being
 * judged on. A model that needs two repairs to produce the schema is worse than
 * one that needs none, and the scorecard says so rather than hiding it behind a
 * successful parse.
 *
 * EVAL CALLS ARE NOT WRITTEN TO `llm_calls` — DELIBERATELY
 * That table is the accounting behind a claim about what RUNNING THE SYSTEM
 * costs. Filling it with calls that classified no anomaly would inflate exactly
 * the number it exists to substantiate, and would make the funnel — anomalies
 * raised versus model calls made — meaningless.
 *
 * So no sink is passed, and the eval reports its own spend from the returned
 * stats instead. This is why `generateStructured` takes an optional injected
 * sink rather than writing to the database itself.
 *
 * FAILURES ARE COLLECTED, NOT THROWN
 * A case that never produced a schema-valid answer is recorded in `failures`
 * and counted separately from wrong answers. That distinction is what let a
 * quota-exhausted run report "5 cases produced no valid answer" instead of
 * looking like a sudden collapse in model quality.
 *
 * `onCaseDone` streams results to the caller so the CLI can print each verdict
 * as it lands, rather than going silent for the minute a full run takes.
 */

import { classificationSchema } from "@obs/shared";
import { CLASSIFIER_SYSTEM_PROMPT } from "../classification/prompt";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import type { GoldenCase } from "./cases";
import { scoreCase, summarise, type CaseScore, type EvalSummary } from "./score";

export interface EvalFailure {
  name: string;
  error: string;
}

/**
 * Does this failure mean the key is out of quota for the day?
 *
 * Free-tier keys have two quotas — five requests per minute and twenty per day
 * — and both produce a 429 asking you to retry in about forty seconds. The
 * transport waits once, which rescues the per-minute case. Nothing rescues the
 * daily one.
 *
 * Without this check a run grinds through every remaining case, waiting for a
 * window that will not open: measured at six minutes to report an exhausted key
 * that could have been reported in forty seconds. So the first daily-quota
 * refusal stops the run.
 *
 * The two are distinguishable only by the limit named in the message, since
 * Google reports both against the same metric. Anything above the per-minute
 * ceiling is treated as the daily one; a genuine per-minute refusal has already
 * been waited out by the time it reaches here.
 */
export function isQuotaExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("429")) return false;

  const limit = /limit:\s*(\d+)/.exec(message);
  return limit?.[1] !== undefined && Number(limit[1]) > 5;
}

/** Remaining cases, recorded as skipped rather than silently dropped. */
export function skipRemaining(
  cases: readonly { name: string }[],
  fromIndex: number,
): EvalFailure[] {
  return cases.slice(fromIndex).map((c) => ({
    name: c.name,
    error: "skipped — the daily quota was exhausted earlier in this run",
  }));
}

export interface EvalRun {
  provider: string;
  model: string;
  scores: CaseScore[];
  failures: EvalFailure[];
  summary: EvalSummary;
}

export async function runEval(
  provider: LlmProvider,
  cases: readonly GoldenCase[],
  onCaseDone?: (score: CaseScore) => void,
): Promise<EvalRun> {
  const scores: CaseScore[] = [];
  const failures: EvalFailure[] = [];

  for (const [index, golden] of cases.entries()) {
    try {
      const { value, stats } = await generateStructured({
        provider,
        schema: classificationSchema,
        system: CLASSIFIER_SYSTEM_PROMPT,
        user: golden.context,
        agent: "classifier",
      });

      const score = scoreCase({
        golden,
        actual: value,
        latencyMs: stats.latencyMs,
        repairAttempts: stats.repairAttempts,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
      });

      scores.push(score);
      onCaseDone?.(score);
    } catch (error) {
      /**
       * A case that never produced a schema-valid answer is a failure of the
       * provider, not a wrong verdict. Counting it as an incorrect answer would
       * blur two different problems — quota exhaustion and bad judgement —
       * into one number.
       */
      failures.push({
        name: golden.name,
        error: error instanceof Error ? error.message : String(error),
      });

      /**
       * A daily-quota refusal will not clear, so grinding through the rest
       * costs minutes to learn nothing. The remaining cases are recorded as
       * skipped rather than dropped, so the count still adds up.
       */
      if (isQuotaExhausted(error)) {
        failures.push(...skipRemaining(cases, index + 1));
        break;
      }
    }
  }

  return {
    provider: provider.name,
    model: provider.model,
    scores,
    failures,
    summary: summarise(scores, failures.length),
  };
}
