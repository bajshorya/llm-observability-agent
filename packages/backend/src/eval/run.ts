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

  for (const golden of cases) {
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
