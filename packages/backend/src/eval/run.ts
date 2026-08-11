import { classificationSchema } from "@obs/shared";
import { CLASSIFIER_SYSTEM_PROMPT } from "../classification/prompt";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import type { GoldenCase } from "./cases";
import { scoreCase, summarise, type CaseScore, type EvalSummary } from "./score";

/**
 * Run the golden set through a provider.
 *
 * Every case goes through `generateStructured` with the real system prompt, so
 * this measures the pipeline rather than a reconstruction of it — including the
 * repair loop, which is itself part of what a provider is being judged on. A
 * model that needs two repairs to produce the schema is worse than one that
 * needs none, and the scorecard says so.
 *
 * Eval calls are **not** written to `llm_calls`. That table is the accounting
 * behind a claim about what running the system costs; filling it with calls
 * that classified no anomaly would inflate exactly the number it exists to
 * substantiate. The eval reports its own spend instead.
 */

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
