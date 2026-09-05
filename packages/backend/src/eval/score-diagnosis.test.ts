/**
 * Tests for the diagnosis scorer.
 *
 * The rules that decide what a number means, not arithmetic:
 *
 *   the two judgement axes are never averaged
 *   fix grounding is scored only where naming a file is the right thing to do
 *   a fix naming an invented file fails, even when the judgement was right
 */

import { describe, expect, it } from "vitest";
import type { Hypothesis } from "@obs/shared";
import type { DiagnosisCase } from "./diagnosis-cases";
import {
  fixNamesACommitFile,
  scoreDiagnosisCase,
  summariseDiagnoses,
  type DiagnosisCaseScore,
} from "./score-diagnosis";

const FILES = ["src/lib/pricing.js", "src/routes/orders.js"];

function golden(explains: boolean, files = FILES): DiagnosisCase {
  return {
    name: explains ? "guilty" : "innocent",
    scenario: "new-error",
    capturedAt: "2026-09-05T00:00:00.000Z",
    sha: "0c701a0bcc".padEnd(40, "f"),
    expect: { explainsTheFailure: explains, note: "…" },
    commitFiles: files,
    context: "…",
  };
}

function answer(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    explainsTheFailure: true,
    rootCause: "formatDiscountedPrice calls toFixed on a nullable column.",
    suggestedFix: "In src/lib/pricing.js, guard discounted_cents before formatting.",
    confidence: 0.9,
    ...overrides,
  };
}

const score = (g: DiagnosisCase, a: Hypothesis): DiagnosisCaseScore =>
  scoreDiagnosisCase({
    golden: g, actual: a, latencyMs: 100, repairAttempts: 0, inputTokens: 10, outputTokens: 5,
  });

describe("fixNamesACommitFile", () => {
  it("accepts a full path", () => {
    expect(fixNamesACommitFile("change src/lib/pricing.js", FILES)).toBe(true);
  });

  it("accepts a bare basename", () => {
    // "in pricing.js" names the file as clearly as the full path does. This is
    // a check against inventing a file, not a test of citation style.
    expect(fixNamesACommitFile("guard the value in pricing.js", FILES)).toBe(true);
  });

  it("rejects a file the commit never touched", () => {
    expect(fixNamesACommitFile("add a check in src/lib/db.js", FILES)).toBe(false);
  });

  it("rejects generic advice that names nothing", () => {
    expect(fixNamesACommitFile("add error handling and validate the input", FILES)).toBe(false);
  });

  it("is false when the commit touched nothing", () => {
    expect(fixNamesACommitFile("change pricing.js", [])).toBe(false);
  });
});

describe("scoreDiagnosisCase", () => {
  it("scores a correct explanation with a grounded fix", () => {
    const result = score(golden(true), answer());

    expect(result.judgementCorrect).toBe(true);
    expect(result.rejectCase).toBe(false);
    expect(result.fixGrounded).toBe(true);
  });

  it("scores a correct rejection", () => {
    const result = score(golden(false), answer({ explainsTheFailure: false }));

    expect(result.rejectCase).toBe(true);
    expect(result.judgementCorrect).toBe(true);
  });

  it("scores agreeing with an innocent commit as wrong", () => {
    // The failure the paired cases exist to catch.
    const result = score(golden(false), answer({ explainsTheFailure: true }));
    expect(result.judgementCorrect).toBe(false);
  });

  it("scores rejecting a real cause as wrong", () => {
    const result = score(golden(true), answer({ explainsTheFailure: false }));
    expect(result.judgementCorrect).toBe(false);
  });

  it("does not score the fix when the model judged the diff innocent", () => {
    // There is no code change to propose, so requiring a filename would
    // penalise the correct answer. Null, not false.
    const result = score(golden(false), answer({ explainsTheFailure: false }));
    expect(result.fixGrounded).toBeNull();
  });

  it("fails a fix naming an invented file even when the judgement was right", () => {
    const result = score(
      golden(true),
      answer({ suggestedFix: "Add a null check in src/lib/invented.js" }),
    );

    expect(result.judgementCorrect).toBe(true);
    expect(result.fixGrounded).toBe(false);
  });
});

describe("summariseDiagnoses", () => {
  it("never averages the two judgement axes", () => {
    // A model that declines everything scores 0/2 and 3/3. Blended that is 60%
    // and reads as respectable; split, the degenerate strategy is obvious.
    const declineAll = [
      score(golden(true), answer({ explainsTheFailure: false })),
      score(golden(true), answer({ explainsTheFailure: false })),
      score(golden(false), answer({ explainsTheFailure: false })),
      score(golden(false), answer({ explainsTheFailure: false })),
      score(golden(false), answer({ explainsTheFailure: false })),
    ];

    const summary = summariseDiagnoses(declineAll, 0);
    expect(summary.explains).toEqual({ correct: 0, total: 2 });
    expect(summary.rejects).toEqual({ correct: 3, total: 3 });
  });

  it("reports the mirror-image failure just as clearly", () => {
    const agreeAll = [
      score(golden(true), answer()),
      score(golden(false), answer()),
      score(golden(false), answer()),
    ];

    const summary = summariseDiagnoses(agreeAll, 0);
    expect(summary.explains).toEqual({ correct: 1, total: 1 });
    expect(summary.rejects).toEqual({ correct: 0, total: 2 });
  });

  it("can show confidence inverted — higher when wrong than when right", () => {
    // Observed on a 3B model, and worse than being uncalibrated.
    const summary = summariseDiagnoses(
      [
        score(golden(true), answer({ confidence: 0.4 })),
        score(golden(false), answer({ explainsTheFailure: true, confidence: 0.8 })),
      ],
      0,
    );

    expect(summary.confidence.whenCorrect).toBeCloseTo(0.4);
    expect(summary.confidence.whenWrong).toBeCloseTo(0.8);
  });

  it("counts provider failures apart from wrong answers", () => {
    const summary = summariseDiagnoses([score(golden(true), answer())], 4);
    expect(summary.failures).toBe(4);
    expect(summary.explains).toEqual({ correct: 1, total: 1 });
  });
});
