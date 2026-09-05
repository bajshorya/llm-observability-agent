/**
 * Tests for the root-cause evidence packet.
 *
 * The properties under test are the ones that decide whether a hypothesis can
 * be reviewed at all: the diff has to be present and complete, the raw error
 * text has to survive normalisation, and an unreadable diff has to say so
 * rather than look like an empty one.
 */

import { describe, expect, it } from "vitest";
import type { AnomalyTrigger, CandidateCommit } from "@obs/shared";
import { renderDiagnosisContext, type DiagnosisInput } from "./context";

const WINDOW_START = new Date("2026-08-16T18:57:00.000Z");
const WINDOW_END = new Date("2026-08-16T19:02:00.000Z");

const DIFF = [
  "diff --git a/src/lib/pricing.js b/src/lib/pricing.js",
  "@@ -4,4 +4,10 @@",
  "+function formatDiscountedPrice(order) {",
  "+  return formatPrice(order.discounted_cents);",
  "+}",
].join("\n");

function commit(overrides: Partial<CandidateCommit> = {}): CandidateCommit {
  return {
    sha: "0c701a0bcc".padEnd(40, "f"),
    committedAt: new Date("2026-08-16T17:25:00.000Z"),
    author: "orders-api ci",
    subject: "feat(pricing): show the promotional total",
    body: "Adds discounted_total to every order response.",
    files: [{ path: "src/lib/pricing.js", added: 7, deleted: 1 }],
    diff: DIFF,
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    service: "orders-api",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    triggers: [
      {
        kind: "new_error_signature",
        service: "orders-api",
        signature: "TypeError: Cannot read properties of null (reading '<str>')",
        sampleMessage: "TypeError: Cannot read properties of null (reading 'toFixed')",
        occurrences: 109,
      } satisfies AnomalyTrigger,
    ],
    severity: "critical",
    summary: "Null dereferences are returning 500s on order read paths.",
    affectedArea: "GET /orders order read path",
    commit: commit(),
    correlationReasoning: "The error names toFixed and this commit added a call to it.",
    correlationConfidence: 0.9,
    implicatedFiles: ["src/lib/pricing.js"],
    ...overrides,
  };
}

describe("renderDiagnosisContext", () => {
  it("carries the symptom, the attribution and the change", () => {
    const text = renderDiagnosisContext(input());

    expect(text).toContain("Severity: critical");
    expect(text).toContain("What the classification stage concluded:");
    expect(text).toContain("What the correlation stage concluded:");
    expect(text).toContain("The commit, in full:");
  });

  it("includes the diff, always", () => {
    // The one thing this stage cannot work without. Correlation treats hunks as
    // a trade; here a line count cannot produce a patch.
    const text = renderDiagnosisContext(input());
    expect(text).toContain("+  return formatPrice(order.discounted_cents);");
  });

  it("does not truncate the diff", () => {
    // Every other packet budgets. A root cause found in the truncated half is
    // a root cause missed, and this stage runs on one commit at most.
    const long = Array.from({ length: 400 }, (_, i) => `+  line ${i}`).join("\n");
    const text = renderDiagnosisContext(input({ commit: commit({ diff: long }) }));

    expect(text).toContain("+  line 0");
    expect(text).toContain("+  line 399");
  });

  it("says an unreadable diff is unavailable rather than rendering nothing", () => {
    // An empty section reads as "this commit changed nothing", which is a
    // different and much stronger claim than "the patch could not be read".
    const text = renderDiagnosisContext(input({ commit: commit({ diff: "" }) }));

    expect(text).toContain("diff: UNAVAILABLE");
    expect(text).not.toContain("    diff:\n");
  });

  it("carries the raw error text, not only the normalised signature", () => {
    // `reading '<str>'` cannot be matched against a line of code.
    const text = renderDiagnosisContext(input());

    expect(text).toContain("reading 'toFixed'");
    expect(text).toContain("raw example:");
  });

  it("passes the correlator's own reasoning through verbatim", () => {
    // So this stage does not silently re-derive the attribution. Two stages
    // quietly answering the same question is how a pipeline stops being
    // auditable.
    const text = renderDiagnosisContext(input());
    expect(text).toContain("The error names toFixed and this commit added a call to it.");
  });

  it("names the implicated files, and says so when there are none", () => {
    expect(renderDiagnosisContext(input())).toContain("Files implicated: src/lib/pricing.js");
    expect(renderDiagnosisContext(input({ implicatedFiles: [] }))).toContain(
      "Files implicated: (none named)",
    );
  });

  it("indents the patch so its markers cannot read as packet structure", () => {
    const text = renderDiagnosisContext(input());

    for (const line of text.split("\n")) {
      if (line.includes("diff --git")) expect(line.startsWith("      ")).toBe(true);
    }
  });
});
