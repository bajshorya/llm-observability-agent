/**
 * Scoring diagnoses — two axes that have answers, and no attempt at the third.
 *
 * WHAT IS MEASURED
 *
 *   1. JUDGEMENT — did it correctly decide whether the diff explains the
 *      failure? Boolean, with a correct value per case.
 *   2. FIX GROUNDING — does the proposed fix name a file the commit actually
 *      touched? Mechanical, in the spirit of `eval/grounding.ts`.
 *
 * WHAT IS NOT, AND WHY
 * Whether the mechanism is *right* and whether the fix is *good*. Both need a
 * human or a second model marking the first one's homework, and a metric that
 * cannot be trusted is worse than no metric. The prose is printed for wrong
 * answers so a person can read it; it is never scored.
 *
 * THE SPLIT, FOR THE THIRD TIME
 * `explains` and `rejects` are reported separately and never averaged. A model
 * that agrees with every attribution scores 100% on one and 0% on the other; a
 * model that rejects everything scores the reverse. Blended, both read as a
 * respectable half — which is exactly what the classifier scorecard learned in
 * §7 of the evals document and the correlation scorecard learned again.
 *
 * WHY FIX GROUNDING IS ONLY SCORED WHERE IT MEANS SOMETHING
 * On a case whose correct answer is "this diff does not explain it", the right
 * response is to propose no code change at all — so there is no file to name
 * and a naming check would punish the correct behaviour. It is scored only on
 * cases the model judged as explained.
 */

import type { Hypothesis } from "@obs/shared";
import type { DiagnosisCase } from "./diagnosis-cases";

export interface DiagnosisCaseScore {
  name: string;
  /** True when the correct answer is "this diff does not explain it". */
  rejectCase: boolean;
  judgementCorrect: boolean;
  /** Null when not applicable — see the header. */
  fixGrounded: boolean | null;
  expected: DiagnosisCase["expect"];
  actual: Hypothesis;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface DiagnosisSummary {
  total: number;
  /** Of the cases the diff really explains, how many were judged so. */
  explains: { correct: number; total: number };
  /** Of the cases it does not, how many were rejected. */
  rejects: { correct: number; total: number };
  /** Fix grounding, over cases judged explained. */
  fixesGrounded: { correct: number; total: number };
  confidence: { whenCorrect: number | null; whenWrong: number | null };
  failures: number;
  totalRepairs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanLatencyMs: number;
}

export interface DiagnosisScoreInput {
  golden: DiagnosisCase;
  actual: Hypothesis;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Does the fix refer to a file the commit actually touched?
 *
 * A substring match on the path and on its basename, because a fix that says
 * "in `pricing.js`" is naming the file as clearly as one that writes the full
 * path. Deliberately generous: this is a check against inventing a file, not a
 * test of citation style.
 */
export function fixNamesACommitFile(fix: string, commitFiles: readonly string[]): boolean {
  if (commitFiles.length === 0) return false;

  const haystack = fix.toLowerCase();
  return commitFiles.some((path) => {
    const lower = path.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    return haystack.includes(lower) || haystack.includes(base);
  });
}

export function scoreDiagnosisCase(input: DiagnosisScoreInput): DiagnosisCaseScore {
  const { golden, actual } = input;

  const rejectCase = golden.expect.explainsTheFailure === false;
  const judgementCorrect = actual.explainsTheFailure === golden.expect.explainsTheFailure;

  /**
   * Only where a file is the right thing to name. On a case correctly judged
   * unexplained there is no code change to propose, so requiring a filename
   * would penalise the correct answer.
   */
  const scoreFix = actual.explainsTheFailure === true;

  return {
    name: golden.name,
    rejectCase,
    judgementCorrect,
    fixGrounded: scoreFix ? fixNamesACommitFile(actual.suggestedFix, golden.commitFiles) : null,
    expected: golden.expect,
    actual,
    latencyMs: input.latencyMs,
    repairAttempts: input.repairAttempts,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  };
}

const count = (
  scores: readonly DiagnosisCaseScore[],
  predicate: (s: DiagnosisCaseScore) => boolean,
): number => scores.filter(predicate).length;

const meanOf = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

export function summariseDiagnoses(
  scores: readonly DiagnosisCaseScore[],
  failures: number,
): DiagnosisSummary {
  const explains = scores.filter((s) => !s.rejectCase);
  const rejects = scores.filter((s) => s.rejectCase);
  const fixScored = scores.filter((s) => s.fixGrounded !== null);
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

  return {
    total: scores.length,
    explains: { correct: count(explains, (s) => s.judgementCorrect), total: explains.length },
    rejects: { correct: count(rejects, (s) => s.judgementCorrect), total: rejects.length },
    fixesGrounded: {
      correct: count(fixScored, (s) => s.fixGrounded === true),
      total: fixScored.length,
    },
    confidence: {
      whenCorrect: meanOf(scores.filter((s) => s.judgementCorrect).map((s) => s.actual.confidence)),
      whenWrong: meanOf(scores.filter((s) => !s.judgementCorrect).map((s) => s.actual.confidence)),
    },
    failures,
    totalRepairs: sum(scores.map((s) => s.repairAttempts)),
    totalInputTokens: sum(scores.map((s) => s.inputTokens ?? 0)),
    totalOutputTokens: sum(scores.map((s) => s.outputTokens ?? 0)),
    meanLatencyMs:
      scores.length > 0 ? Math.round(sum(scores.map((s) => s.latencyMs)) / scores.length) : 0,
  };
}
