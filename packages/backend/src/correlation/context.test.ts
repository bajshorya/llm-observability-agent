/**
 * Tests for the correlation evidence packet.
 *
 * Pure input, pure output, so every case here is a literal. What is being
 * checked is not formatting for its own sake but three properties the packet
 * has to hold:
 *
 *   the raw error text survives      it is the strongest symptom-to-code link
 *   "no candidates" is explicit      absent evidence and searched-and-found-
 *                                    nothing must not look the same
 *   budgets cap without hiding       an elision always prints what it elided
 */

import { describe, expect, it } from "vitest";
import type { AnomalyTrigger, CandidateCommit, CommitWindow } from "@obs/shared";
import {
  correlationBudget,
  describeAge,
  renderCorrelationContext,
  type CorrelationInput,
} from "./context";

const WINDOW_START = new Date("2026-08-16T18:57:00.000Z");
const WINDOW_END = new Date("2026-08-16T19:02:00.000Z");

function commit(overrides: Partial<CandidateCommit> = {}): CandidateCommit {
  return {
    sha: "0c701a0f".padEnd(40, "0"),
    committedAt: new Date("2026-08-16T17:25:00.000Z"),
    author: "orders-api ci",
    subject: "feat(pricing): show the promotional total on order responses",
    body: "Adds discounted_total to every order response.",
    files: [{ path: "src/lib/pricing.js", added: 7, deleted: 1 }],
    diff: "",
    ...overrides,
  };
}

function input(overrides: Partial<CorrelationInput> = {}): CorrelationInput {
  const commits: CommitWindow = {
    commits: [commit()],
    since: new Date("2026-08-14T19:02:00.000Z"),
    until: WINDOW_END,
  };

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
    commits,
    ...overrides,
  };
}

describe("renderCorrelationContext", () => {
  it("carries the incident and the candidates as two halves", () => {
    const text = renderCorrelationContext(input());

    expect(text).toContain("Service: orders-api");
    expect(text).toContain("Severity: critical");
    expect(text).toContain("Affected area: GET /orders order read path");
    expect(text).toContain("Already established by the classification stage:");
    expect(text).toContain("Candidate commits (1)");
  });

  it("renders the raw error text verbatim, not summarised", () => {
    // The single highest-value line in the packet: it names an operation and a
    // type, which is what makes a commit checkable against it.
    const text = renderCorrelationContext(input());
    expect(text).toContain("Cannot read properties of null (reading 'toFixed')");
  });

  it("renders a short sha the model can copy without typing 40 hex characters", () => {
    const text = renderCorrelationContext(input());
    expect(text).toContain("0c701a0f00");
  });

  it("prints the age relative to the window alongside the timestamp", () => {
    const text = renderCorrelationContext(input());
    expect(text).toContain("2026-08-16 17:25Z");
    expect(text).toContain("1h 37m before");
  });

  it("states explicitly that no candidates were found, rather than omitting the section", () => {
    // "We searched and found nothing" is what makes null a correct answer.
    // A missing section would read as "not provided", which does not.
    const text = renderCorrelationContext(
      input({ commits: { commits: [], since: new Date("2026-08-14T19:02:00.000Z"), until: WINDOW_END } }),
    );

    expect(text).toContain("Candidate commits: NONE.");
    expect(text).toContain("this is not missing data");
    expect(text).not.toContain("newest first");
  });

  it("says out loud when a commit changed no files", () => {
    const text = renderCorrelationContext(
      input({
        commits: { commits: [commit({ files: [] })], since: WINDOW_START, until: WINDOW_END },
      }),
    );
    expect(text).toContain("(none — this commit changed no files)");
  });

  it("reports a binary file as binary rather than as zero lines changed", () => {
    const text = renderCorrelationContext(
      input({
        commits: {
          commits: [commit({ files: [{ path: "public/logo.png", added: null, deleted: null }] })],
          since: WINDOW_START,
          until: WINDOW_END,
        },
      }),
    );

    expect(text).toContain("public/logo.png  binary");
    expect(text).not.toContain("+0/-0");
  });

  it("caps files per commit but prints how many it elided", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file-${i}.js`,
      added: 1,
      deleted: 0,
    }));

    const text = renderCorrelationContext(
      input({
        commits: { commits: [commit({ files })], since: WINDOW_START, until: WINDOW_END },
      }),
    );

    expect(text).toContain("files (20):");
    expect(text).toContain(`… and ${20 - correlationBudget.maxFilesPerCommit} more`);
    expect(text).not.toContain("src/file-19.js");
  });

  it("caps commits but prints how many it elided", () => {
    const commits = Array.from({ length: correlationBudget.maxCommits + 4 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "a") }),
    );

    const text = renderCorrelationContext(
      input({ commits: { commits, since: WINDOW_START, until: WINDOW_END } }),
    );

    expect(text).toContain(`Candidate commits (${correlationBudget.maxCommits + 4})`);
    expect(text).toContain("… and 4 older commits not shown");
  });

  it("indents a multi-paragraph body so it cannot be read as the next commit", () => {
    const text = renderCorrelationContext(
      input({
        commits: {
          commits: [commit({ body: "First paragraph.\n\nSecond paragraph." })],
          since: WINDOW_START,
          until: WINDOW_END,
        },
      }),
    );

    for (const line of text.split("\n")) {
      if (line.includes("Second paragraph.")) expect(line.startsWith("      ")).toBe(true);
    }
  });
});

describe("diffs in the packet", () => {
  const DIFF = [
    "diff --git a/src/lib/pricing.js b/src/lib/pricing.js",
    "--- a/src/lib/pricing.js",
    "+++ b/src/lib/pricing.js",
    "@@ -4,4 +4,10 @@",
    "+function formatDiscountedPrice(order) {",
    "+  return formatPrice(order.discounted_cents);",
    "+}",
  ].join("\n");

  const withDiff = (diff: string) =>
    input({
      commits: { commits: [commit({ diff })], since: WINDOW_START, until: WINDOW_END },
    });

  it("omits the diff by default", () => {
    // Off in the shipped packet: a controlled A/B did not support turning it
    // on. See DOCUMENTATION-EVALS.md §14.
    const text = renderCorrelationContext(withDiff(DIFF));

    expect(text).not.toContain("diff:");
    expect(text).toContain("src/lib/pricing.js  +7/-1");
  });

  it("renders the diff when asked", () => {
    const text = renderCorrelationContext(withDiff(DIFF), { diffs: true });

    expect(text).toContain("diff:");
    expect(text).toContain("+  return formatPrice(order.discounted_cents);");
  });

  it("changes nothing but the hunks between the two arms", () => {
    // What makes the A/B controlled: both packets come from one incident, so
    // the only difference is the diff itself.
    const on = renderCorrelationContext(withDiff(DIFF), { diffs: true });
    const off = renderCorrelationContext(withDiff(DIFF), { diffs: false });

    expect(off).not.toContain("formatDiscountedPrice");
    for (const line of off.split("\n")) {
      expect(on).toContain(line);
    }
  });

  it("indents the patch so its own markers cannot read as packet structure", () => {
    // A patch contains --- and +++ at column zero; unindented they would look
    // like sections of the evidence rather than part of a diff.
    const text = renderCorrelationContext(withDiff(DIFF), { diffs: true });

    for (const line of text.split("\n")) {
      if (line.includes("+++ b/src/lib/pricing.js")) {
        expect(line.startsWith("      ")).toBe(true);
      }
    }
  });

  it("truncates by line and says how many it cut", () => {
    const long = Array.from({ length: 100 }, (_, i) => `+  line ${i}`).join("\n");
    const text = renderCorrelationContext(withDiff(long), { diffs: true });

    expect(text).toContain(`… ${100 - correlationBudget.maxDiffLinesPerCommit} more diff line(s)`);
    expect(text).toContain("+  line 0");
    expect(text).not.toContain("+  line 99");
  });

  it("renders nothing extra for a commit with no diff", () => {
    const text = renderCorrelationContext(withDiff(""), { diffs: true });
    expect(text).not.toContain("diff:");
  });

  it("spends the total budget newest-first and still shows every candidate", () => {
    // A candidate the model never sees cannot be ruled out either, so commits
    // past the budget lose their hunks — not their entry.
    const long = Array.from({ length: 40 }, (_, i) => `+  line ${i}`).join("\n");
    const many = Array.from({ length: 12 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "a"), subject: `commit number ${i}`, diff: long }),
    );

    const text = renderCorrelationContext(
      input({ commits: { commits: many, since: WINDOW_START, until: WINDOW_END } }),
      { diffs: true },
    );

    for (let i = 0; i < 12; i += 1) {
      expect(text).toContain(`commit number ${i}`);
    }

    // The budget is spent down rather than divided, so the commit that
    // straddles the limit gets a partial diff rather than none. What must hold
    // is the cap itself.
    const patchLines = text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("+  line "));

    expect(patchLines.length).toBeLessThanOrEqual(correlationBudget.maxDiffLinesTotal);
    expect(patchLines.length).toBeGreaterThan(correlationBudget.maxDiffLinesTotal - 40);
  });
});

describe("describeAge", () => {
  const end = new Date("2026-08-16T19:02:00.000Z");

  it("reads in minutes and hours close to the window", () => {
    expect(describeAge(new Date("2026-08-16T18:20:00.000Z"), end)).toBe("42m before");
    expect(describeAge(new Date("2026-08-16T17:25:00.000Z"), end)).toBe("1h 37m before");
  });

  it("drops minutes once it is into days, rather than implying false precision", () => {
    expect(describeAge(new Date("2026-08-14T19:02:00.000Z"), end)).toBe("2d before");
    expect(describeAge(new Date("2026-08-15T09:00:00.000Z"), end)).toBe("1d 10h before");
  });

  it("distinguishes a commit landing inside the window from one before it", () => {
    expect(describeAge(end, end)).toBe("as the window ended");
    expect(describeAge(new Date("2026-08-16T19:30:00.000Z"), end)).toBe("after the window ended");
  });
});
