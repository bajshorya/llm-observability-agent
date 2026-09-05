/**
 * Running the diagnosis golden set through a provider.
 *
 * Same shape as the two runners before it: the real `generateStructured`, the
 * real `ROOT_CAUSE_SYSTEM_PROMPT`, the repair loop included, and no sink — eval
 * calls are never written to `llm_calls`, because that table substantiates a
 * claim about what running the system costs.
 */

import { hypothesisSchema } from "@obs/shared";
import { ROOT_CAUSE_SYSTEM_PROMPT } from "../diagnosis/prompt";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import type { DiagnosisCase } from "./diagnosis-cases";
import {
  scoreDiagnosisCase,
  summariseDiagnoses,
  type DiagnosisCaseScore,
  type DiagnosisSummary,
} from "./score-diagnosis";
import type { EvalFailure } from "./run";

export interface DiagnosisEvalRun {
  provider: string;
  model: string;
  scores: DiagnosisCaseScore[];
  failures: EvalFailure[];
  summary: DiagnosisSummary;
}

export async function runDiagnosisEval(
  provider: LlmProvider,
  cases: readonly DiagnosisCase[],
  onCaseDone?: (score: DiagnosisCaseScore) => void,
): Promise<DiagnosisEvalRun> {
  const scores: DiagnosisCaseScore[] = [];
  const failures: EvalFailure[] = [];

  for (const golden of cases) {
    try {
      const { value, stats } = await generateStructured({
        provider,
        schema: hypothesisSchema,
        system: ROOT_CAUSE_SYSTEM_PROMPT,
        user: golden.context,
        agent: "root_cause",
      });

      const score = scoreDiagnosisCase({
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
    summary: summariseDiagnoses(scores, failures.length),
  };
}
