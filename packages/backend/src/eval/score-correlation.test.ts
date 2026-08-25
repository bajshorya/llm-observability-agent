/**
 * Tests for the correlation scorer.
 *
 * The rules under test are the ones that decide what a number MEANS, not
 * arithmetic. Three in particular:
 *
 *   attribution and declining are never averaged
 *   files are scored only where they can mean something
 *   a prefix answer matches, but only in one direction
 */

import { describe, expect, it } from "vitest";
import type { Correlation } from "@obs/shared";
import type { CorrelationCase } from "./correlation-cases";
import {
  scoreCorrelationCase,
  shaMatches,
  summariseCorrelations,
  type CorrelationCaseScore,
} from "./score-correlation";

const BUG = "0c701a0bcc".padEnd(40, "f");
const OTHER = "8a38dbc5a4".padEnd(40, "e");

function golden(overrides: Partial<CorrelationCase["expect"]> = {}): CorrelationCase {
  return {
    name: "new-error",
    scenario: "new-error",
    capturedAt: "2026-08-25T00:00:00.000Z",
    expect: {
      suspectedCommitSha: BUG,
      implicatedFiles: ["src/lib/pricing.js"],
      note: "the null-price bug",
      ...overrides,
    },
    context: "…",
  };
}

function answer(overrides: Partial<Correlation> = {}): Correlation {
  return {
    suspectedCommitSha: BUG.slice(0, 10),
    confidence: 0.9,
    reasoning: "The error names toFixed and this commit introduced a call to it.",
    changedFilesImplicated: ["src/lib/pricing.js"],
    ...overrides,
  };
}

function score(g: CorrelationCase, a: Correlation): CorrelationCaseScore {
  return scoreCorrelationCase({
    golden: g,
    actual: a,
    latencyMs: 100,
    repairAttempts: 0,
    inputTokens: 10,
    outputTokens: 5,
  });
}

describe("shaMatches", () => {
  it("accepts an abbreviation of the expected sha", () => {
    expect(shaMatches(BUG.slice(0, 7), BUG)).toBe(true);
    expect(shaMatches(BUG.slice(0, 10), BUG)).toBe(true);
    expect(shaMatches(BUG, BUG)).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(shaMatches(`  ${BUG.slice(0, 10).toUpperCase()} `, BUG)).toBe(true);
  });

  it("rejects a different commit", () => {
    expect(shaMatches(OTHER.slice(0, 10), BUG)).toBe(false);
  });

  it("matches only in one direction", () => {
    // The answer must be a prefix of the label, never the reverse. Otherwise a
    // label captured at 7 characters would accept any longer sha starting the
    // same way — including a genuinely different commit.
    expect(shaMatches(BUG, BUG.slice(0, 7))).toBe(false);
  });

  it("treats null as matching only null", () => {
    expect(shaMatches(null, null)).toBe(true);
    expect(shaMatches(null, BUG)).toBe(false);
    expect(shaMatches(BUG, null)).toBe(false);
  });
});

describe("scoreCorrelationCase", () => {
  it("scores a correct attribution with the right files", () => {
    const result = score(golden(), answer());

    expect(result.attributionCorrect).toBe(true);
    expect(result.declineCase).toBe(false);
    expect(result.filesCorrect).toBe(true);
    expect(result.missingFiles).toEqual([]);
  });

  it("scores naming a different commit as wrong", () => {
    const result = score(golden(), answer({ suspectedCommitSha: OTHER }));
    expect(result.attributionCorrect).toBe(false);
  });

  it("scores declining on an attributable case as wrong", () => {
    const result = score(
      golden(),
      answer({ suspectedCommitSha: null, changedFilesImplicated: [] }),
    );
    expect(result.attributionCorrect).toBe(false);
  });

  it("scores a correct decline as correct", () => {
    const result = score(
      golden({ suspectedCommitSha: null, implicatedFiles: [] }),
      answer({ suspectedCommitSha: null, changedFilesImplicated: [] }),
    );

    expect(result.declineCase).toBe(true);
    expect(result.attributionCorrect).toBe(true);
  });

  it("scores naming any commit on a decline case as wrong", () => {
    const result = score(golden({ suspectedCommitSha: null, implicatedFiles: [] }), answer());
    expect(result.attributionCorrect).toBe(false);
  });

  it("does not score files on a decline case", () => {
    // null, not false: "not applicable" must never dilute the file axis.
    const result = score(
      golden({ suspectedCommitSha: null, implicatedFiles: [] }),
      answer({ suspectedCommitSha: null, changedFilesImplicated: [] }),
    );
    expect(result.filesCorrect).toBeNull();
  });

  it("does not score files when the commit was wrong", () => {
    // Already counted once by the attribution axis. Counting it again would
    // punish one mistake twice and make this axis an echo of that one.
    const result = score(golden(), answer({ suspectedCommitSha: OTHER }));
    expect(result.filesCorrect).toBeNull();
  });

  it("does not score files when the label names none", () => {
    const result = score(golden({ implicatedFiles: [] }), answer());
    expect(result.filesCorrect).toBeNull();
  });

  it("accepts a superset of the expected files", () => {
    // Breadth, not error: a second file the commit really touched is not
    // something a reviewer would object to.
    const result = score(
      golden(),
      answer({ changedFilesImplicated: ["src/lib/pricing.js", "src/routes/orders.js"] }),
    );

    expect(result.filesCorrect).toBe(true);
  });

  it("reports which expected files were missed", () => {
    const result = score(
      golden({ implicatedFiles: ["src/lib/pricing.js", "src/routes/orders.js"] }),
      answer({ changedFilesImplicated: ["src/lib/pricing.js"] }),
    );

    expect(result.filesCorrect).toBe(false);
    expect(result.missingFiles).toEqual(["src/routes/orders.js"]);
  });
});

describe("summariseCorrelations", () => {
  const attributable = (correct: boolean, confidence: number): CorrelationCaseScore =>
    score(golden(), answer({ suspectedCommitSha: correct ? BUG : OTHER, confidence }));

  const decline = (correct: boolean): CorrelationCaseScore =>
    score(
      golden({ suspectedCommitSha: null, implicatedFiles: [] }),
      correct ? answer({ suspectedCommitSha: null, changedFilesImplicated: [] }) : answer(),
    );

  it("never averages attribution with declining", () => {
    // The failure this split exists to expose: a model that always names
    // something is perfect on one axis and useless on the other, and a blended
    // number would read as a respectable 50%.
    const summary = summariseCorrelations(
      [attributable(true, 0.9), attributable(true, 0.9), decline(false), decline(false)],
      0,
    );

    expect(summary.attributions).toEqual({ correct: 2, total: 2 });
    expect(summary.declines).toEqual({ correct: 0, total: 2 });
  });

  it("reports the mirror-image failure just as clearly", () => {
    const summary = summariseCorrelations(
      [attributable(false, 0.2), attributable(false, 0.2), decline(true), decline(true)],
      0,
    );

    expect(summary.attributions).toEqual({ correct: 0, total: 2 });
    expect(summary.declines).toEqual({ correct: 2, total: 2 });
  });

  it("separates confidence when right from when wrong", () => {
    // The failure worth catching is a model that is confidently wrong.
    const summary = summariseCorrelations([attributable(true, 0.9), attributable(false, 0.8)], 0);

    expect(summary.confidence.whenCorrect).toBeCloseTo(0.9);
    expect(summary.confidence.whenWrong).toBeCloseTo(0.8);
  });

  it("reports null confidence rather than zero when an arm is empty", () => {
    // Zero would read as "confidently wrong on everything" rather than "there
    // were no wrong answers".
    const summary = summariseCorrelations([attributable(true, 0.9)], 0);

    expect(summary.confidence.whenCorrect).toBeCloseTo(0.9);
    expect(summary.confidence.whenWrong).toBeNull();
  });

  it("counts provider failures apart from wrong answers", () => {
    const summary = summariseCorrelations([attributable(true, 0.9)], 3);

    expect(summary.failures).toBe(3);
    expect(summary.attributions).toEqual({ correct: 1, total: 1 });
  });

  it("excludes unscored file cases from the file axis", () => {
    const summary = summariseCorrelations([attributable(true, 0.9), decline(true)], 0);
    expect(summary.files).toEqual({ correct: 1, total: 1 });
  });
});
