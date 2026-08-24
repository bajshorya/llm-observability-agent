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
