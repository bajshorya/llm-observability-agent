import type { Classification, Severity } from "@obs/shared";
import { checkGrounding, type GroundingResult } from "./grounding";
import type { GoldenCase } from "./cases";

/**
 * Scoring, kept pure and separate from the calls that produce the answers.
 *
 * Three things are measured, in order of how much they matter:
 *
 *   1. **The verdict.** Real incident or not. This is the judgement the whole
 *      tier exists to make, and the only one with an unambiguous right answer.
 *   2. **Severity, within one band.** The line between high and critical is a
 *      matter of taste; the line between low and critical is not. Exact match
 *      is reported too, but it is not the headline — demanding it would be
 *      scoring agreement with one labeller's taste.
 *   3. **Grounding.** Did it invent a location?
 *
 * Deliberately not measured: summary wording. Grading prose needs either a
 * human or a second model marking the first one's homework, and a metric that
 * cannot be trusted is worse than no metric.
 */

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function severityDistance(a: Severity, b: Severity): number {
  return Math.abs(SEVERITY_RANK[a] - SEVERITY_RANK[b]);
}

export interface CaseScore {
  name: string;
  benignCase: boolean;
  verdictCorrect: boolean;
  severityExact: boolean;
  severityWithinOne: boolean;
  grounding: GroundingResult;
  expected: GoldenCase["expect"];
  actual: Classification;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface EvalSummary {
  total: number;
  /** Verdict accuracy over the benign half — the number that matters most. */
  dismissals: { correct: number; total: number };
  /** Verdict accuracy over the real incidents. */
  incidents: { correct: number; total: number };
  verdictCorrect: number;
  severityExact: number;
  severityWithinOne: number;
  grounded: number;
  failures: number;
  totalRepairs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanLatencyMs: number;
}

export interface ScoreInput {
  golden: GoldenCase;
  actual: Classification;
  latencyMs: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function scoreCase(input: ScoreInput): CaseScore {
  const { golden, actual } = input;
  const distance = severityDistance(golden.expect.severity, actual.severity);

  return {
    name: golden.name,
    benignCase: !golden.expect.isRealIncident,
    verdictCorrect: actual.isRealIncident === golden.expect.isRealIncident,
    severityExact: distance === 0,
    severityWithinOne: distance <= 1,
    grounding: checkGrounding(actual.affectedArea, golden.context),
    expected: golden.expect,
    actual,
    latencyMs: input.latencyMs,
    repairAttempts: input.repairAttempts,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  };
}

const count = (scores: readonly CaseScore[], predicate: (s: CaseScore) => boolean): number =>
  scores.filter(predicate).length;

export function summarise(scores: readonly CaseScore[], failures: number): EvalSummary {
  const benign = scores.filter((score) => score.benignCase);
  const incidents = scores.filter((score) => !score.benignCase);
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

  return {
    total: scores.length,
    dismissals: {
      correct: count(benign, (score) => score.verdictCorrect),
      total: benign.length,
    },
    incidents: {
      correct: count(incidents, (score) => score.verdictCorrect),
      total: incidents.length,
    },
    verdictCorrect: count(scores, (score) => score.verdictCorrect),
    severityExact: count(scores, (score) => score.severityExact),
    severityWithinOne: count(scores, (score) => score.severityWithinOne),
    grounded: count(scores, (score) => score.grounding.grounded),
    failures,
    totalRepairs: sum(scores.map((score) => score.repairAttempts)),
    totalInputTokens: sum(scores.map((score) => score.inputTokens ?? 0)),
    totalOutputTokens: sum(scores.map((score) => score.outputTokens ?? 0)),
    meanLatencyMs:
      scores.length > 0 ? Math.round(sum(scores.map((score) => score.latencyMs)) / scores.length) : 0,
  };
}
