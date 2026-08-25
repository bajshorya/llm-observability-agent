/**
 * Running the correlation golden set through a provider.
 *
 * WHAT THIS FILE DOES
 * The Phase 3 counterpart to `run.ts`. Iterates the cases, sends each through
 * the real `generateStructured` with the real `CORRELATOR_SYSTEM_PROMPT`,
 * scores the result, and returns per-case scores plus a summary.
 *
 * IT MEASURES THE PIPELINE, NOT A RECONSTRUCTION OF IT
 * Same code path a real correlation takes, repair loop included — a model that
 * needs two repairs to produce the schema is worse than one that needs none,
 * and the scorecard says so.
 *
 * WITH ONE DELIBERATE DIFFERENCE: GROUNDING IS NOT APPLIED HERE
 * The pipeline runs every answer through `groundCorrelation`, which fails an
 * invented sha and drops an invented file. The eval does NOT, and that is the
 * point — those are exactly the mistakes worth measuring. Running the check
 * first would convert a hallucination into a run-time failure and score it as
 * "the provider errored" rather than "the model invented a commit".
 *
 * So a sha naming nothing simply scores as a wrong attribution, which is what
 * it is. `--verbose` prints the answer, so an invented sha is visible as a sha
 * that appears in no candidate list.
 *
 * EVAL CALLS ARE NOT WRITTEN TO `llm_calls`
 * Same reason as `run.ts`: that table substantiates a claim about what running
 * the system costs, and filling it with calls that correlated no anomaly would
 * inflate the number it exists to support. No sink is passed.
 */

import { correlationSchema } from "@obs/shared";
import { CORRELATOR_SYSTEM_PROMPT } from "../correlation/prompt";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import type { CorrelationCase } from "./correlation-cases";
import {
  scoreCorrelationCase,
  summariseCorrelations,
  type CorrelationCaseScore,
  type CorrelationSummary,
} from "./score-correlation";
import type { EvalFailure } from "./run";

export interface CorrelationEvalRun {
  provider: string;
  model: string;
  scores: CorrelationCaseScore[];
  failures: EvalFailure[];
  summary: CorrelationSummary;
}

export async function runCorrelationEval(
  provider: LlmProvider,
  cases: readonly CorrelationCase[],
  onCaseDone?: (score: CorrelationCaseScore) => void,
): Promise<CorrelationEvalRun> {
  const scores: CorrelationCaseScore[] = [];
  const failures: EvalFailure[] = [];

  for (const golden of cases) {
    try {
      const { value, stats } = await generateStructured({
        provider,
        schema: correlationSchema,
        system: CORRELATOR_SYSTEM_PROMPT,
        user: golden.context,
        agent: "correlator",
      });

      const score = scoreCorrelationCase({
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
    summary: summariseCorrelations(scores, failures.length),
  };
}
