/**
 * Scoring correlations — turning a model's attributions into numbers, purely.
 *
 * WHAT THIS FILE DOES
 * Compares one correlation against its label (`scoreCorrelationCase`) and
 * aggregates a run (`summariseCorrelations`). No I/O and no provider calls, so
 * the rules are testable with fixed inputs.
 *
 * THE FOUR AXES, AND WHY THEY ARE FOUR AND NOT ONE
 * `DOCUMENTATION-EVALS.md` §7 records what a blended number hid once already:
 * a model that answered "critical incident" to everything scored 3/3 on the
 * incident half and looked mediocre rather than pathological. The same trap is
 * waiting here in two directions at once, so the scorecard splits.
 *
 *   1. ATTRIBUTION   when a commit IS responsible, was the right one named?
 *   2. DECLINING     when NO commit is responsible, did it say so?
 *   3. FILES         within a correctly named commit, the right paths?
 *   4. CONFIDENCE    is it higher when right than when wrong?
 *
 * Axes 1 and 2 must never be averaged. A model that names the newest commit
 * every time scores 100% on attribution and 0% on declining; a model that
 * always declines scores the reverse. Blended, both read as "about half" —
 * indistinguishable from a model that is genuinely half right, and each is a
 * completely different failure.
 *
 * WHY FILES ARE SCORED ONLY ON CORRECTLY ATTRIBUTED CASES
 * Files named inside the wrong commit are already counted as a wrong answer by
 * axis 1. Scoring them again would punish one mistake twice and would make the
 * file axis a noisy echo of the attribution axis rather than an independent
 * measure of whether the model can point at the right part of a diff.
 *
 * WHY FILES ARE A SUBSET CHECK AND NOT AN EXACT MATCH
 * The label names the paths that carry the fault. A model that also names a
 * second file the commit genuinely touched has not made an error a reviewer
 * would object to — it has been broader than necessary. Requiring exactness
 * would score agreement with one labeller's taste, the same reason severity is
 * scored within one band rather than exactly.
 *
 * WHY CONFIDENCE IS MEASURED AT ALL
 * Phase 4 will threshold on it. An uncalibrated confidence is worse than none,
 * because downstream code will trust it. The measure here is deliberately
 * coarse — mean confidence when right versus when wrong — because with a
 * handful of cases anything finer would be reading noise. What it can catch is
 * the failure that matters: a model that is confidently wrong.
 *
 * DELIBERATELY NOT MEASURED: THE REASONING TEXT
 * Grading prose needs a human or a second model marking the first one's
 * homework. `reasoning` exists to be checked by a person, and the prompt
 * requires a stated mechanism precisely so that check is possible — but a
 * number attached to it here would be a number nobody should trust.
 */

import type { Correlation } from "@obs/shared";
import type { CorrelationCase } from "./correlation-cases";

export interface CorrelationCaseScore {
  name: string;
  /** True when the correct answer is "no commit explains this". */
  declineCase: boolean;
  /** Did the model give the right sha, or correctly give none? */
  attributionCorrect: boolean;
  /** Null when not applicable: a decline case, or a wrong attribution. */
  filesCorrect: boolean | null;
  /** Paths the label expected that the model did not name. */
  missingFiles: string[];
  expected: CorrelationCase["expect"];
  actual: Correlation;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CorrelationSummary {
  total: number;
  /** Axis 1 — of the cases where a commit is responsible, how many were right. */
  attributions: { correct: number; total: number };
  /** Axis 2 — of the cases where none is, how many declined. */
  declines: { correct: number; total: number };
  /** Axis 3 — file accuracy, over correctly attributed cases only. */
  files: { correct: number; total: number };
  /** Axis 4 — mean confidence when right and when wrong. */
  confidence: { whenCorrect: number | null; whenWrong: number | null };
  failures: number;
  totalRepairs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanLatencyMs: number;
}

export interface CorrelationScoreInput {
  golden: CorrelationCase;
  actual: Correlation;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Does the model's answer name the expected commit?
 *
 * A prefix match, because the packet renders 10 characters and the schema
 * accepts 7 to 40 — a model that abbreviates has not made a mistake. The
 * comparison is one-directional on purpose: the ANSWER must be a prefix of the
 * expected sha, never the reverse, so a 7-character answer that happens to
 * extend past the label cannot pass.
 */
export function shaMatches(answer: string | null, expected: string | null): boolean {
  if (expected === null || answer === null) return answer === expected;
  return expected.toLowerCase().startsWith(answer.trim().toLowerCase());
}

export function scoreCorrelationCase(input: CorrelationScoreInput): CorrelationCaseScore {
  const { golden, actual } = input;

  const declineCase = golden.expect.suspectedCommitSha === null;
  const attributionCorrect = shaMatches(actual.suspectedCommitSha, golden.expect.suspectedCommitSha);

  /**
   * Files are scored only where they can mean something: a correctly named
   * commit, with a label that actually lists paths. Anywhere else this is null
   * rather than false, so "not applicable" never dilutes the axis.
   */
  const scoreFiles = attributionCorrect && !declineCase && golden.expect.implicatedFiles.length > 0;

  const named = new Set(actual.changedFilesImplicated);
  const missingFiles = scoreFiles
    ? golden.expect.implicatedFiles.filter((path) => !named.has(path))
    : [];

  return {
    name: golden.name,
    declineCase,
    attributionCorrect,
    // Subset, not exact: naming an extra file the commit really touched is
    // breadth, not error.
    filesCorrect: scoreFiles ? missingFiles.length === 0 : null,
    missingFiles,
    expected: golden.expect,
    actual,
    latencyMs: input.latencyMs,
    repairAttempts: input.repairAttempts,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  };
}

const count = (
  scores: readonly CorrelationCaseScore[],
  predicate: (s: CorrelationCaseScore) => boolean,
): number => scores.filter(predicate).length;

const meanOf = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

export function summariseCorrelations(
  scores: readonly CorrelationCaseScore[],
  failures: number,
): CorrelationSummary {
  const attributable = scores.filter((score) => !score.declineCase);
  const declinable = scores.filter((score) => score.declineCase);
  const scored = scores.filter((score) => score.filesCorrect !== null);
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

  return {
    total: scores.length,
    attributions: {
      correct: count(attributable, (score) => score.attributionCorrect),
      total: attributable.length,
    },
    declines: {
      correct: count(declinable, (score) => score.attributionCorrect),
      total: declinable.length,
    },
    files: {
      correct: count(scored, (score) => score.filesCorrect === true),
      total: scored.length,
    },
    confidence: {
      whenCorrect: meanOf(
        scores.filter((s) => s.attributionCorrect).map((s) => s.actual.confidence),
      ),
      whenWrong: meanOf(
        scores.filter((s) => !s.attributionCorrect).map((s) => s.actual.confidence),
      ),
    },
    failures,
    totalRepairs: sum(scores.map((score) => score.repairAttempts)),
    totalInputTokens: sum(scores.map((score) => score.inputTokens ?? 0)),
    totalOutputTokens: sum(scores.map((score) => score.outputTokens ?? 0)),
    meanLatencyMs:
      scores.length > 0
        ? Math.round(sum(scores.map((score) => score.latencyMs)) / scores.length)
        : 0,
  };
}
