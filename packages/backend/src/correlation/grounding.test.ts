/**
 * Tests for the correlation grounding check.
 *
 * Every case is a literal — the function is pure, and the cases that matter
 * most are hallucinations, which are inconvenient to obtain from a real model
 * on demand and trivial to write down.
 *
 * The asymmetry between the two failure kinds is the thing under test: an
 * invented sha must fail, an invented file must not. That is not a formatting
 * preference. A sha is the causal claim; a file list is supporting detail, and
 * the sha still points at a diff a human can open either way.
 */

import { describe, expect, it } from "vitest";
import type { CandidateCommit, Correlation } from "@obs/shared";
import { groundCorrelation } from "./grounding";

const BUG = "0c701a0bcc".padEnd(40, "f");
const DECOY = "0c4abb15b2".padEnd(40, "e");

const candidates: CandidateCommit[] = [
  {
    sha: BUG,
    committedAt: new Date("2026-08-16T17:25:00.000Z"),
    author: "ci",
    subject: "feat(pricing): show the promotional total",
    body: "",
    files: [
      { path: "src/lib/pricing.js", added: 7, deleted: 1 },
      { path: "src/routes/orders.js", added: 2, deleted: 1 },
    ],
  },
  {
    sha: DECOY,
    committedAt: new Date("2026-08-15T17:00:00.000Z"),
    author: "ci",
    subject: "refactor(pricing): extract formatPrice",
    body: "",
    files: [{ path: "src/lib/pricing.js", added: 7, deleted: 0 }],
  },
];

function answer(overrides: Partial<Correlation> = {}): Correlation {
  return {
    suspectedCommitSha: BUG.slice(0, 10),
    confidence: 0.9,
    reasoning: "The error names toFixed and this commit added a call to it.",
    changedFilesImplicated: ["src/lib/pricing.js"],
    ...overrides,
  };
}

describe("groundCorrelation", () => {
  it("expands an abbreviated sha to the full one it was shown", () => {
    const result = groundCorrelation(answer(), candidates);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounded.sha).toBe(BUG);
      expect(result.grounded.implicatedFiles).toEqual(["src/lib/pricing.js"]);
      expect(result.grounded.droppedFiles).toEqual([]);
    }
  });

  it("accepts a full sha unchanged", () => {
    const result = groundCorrelation(answer({ suspectedCommitSha: BUG }), candidates);
    expect(result.ok && result.grounded.sha).toBe(BUG);
  });

  it("accepts the shortest sha the schema allows", () => {
    const result = groundCorrelation(answer({ suspectedCommitSha: BUG.slice(0, 7) }), candidates);
    expect(result.ok && result.grounded.sha).toBe(BUG);
  });

  it("rejects a sha that names no candidate", () => {
    // Fatal on purpose. Coercing this to null would record a hallucination as
    // a considered "no commit explains this", corrupting the one measurement
    // the nullable field exists to make possible.
    const result = groundCorrelation(
      answer({ suspectedCommitSha: "deadbeef" }),
      candidates,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("deadbeef");
      expect(result.reason).toContain("2 candidate(s)");
    }
  });

  it("rejects an ambiguous prefix rather than picking the first match", () => {
    // Guessing between two commits would attribute an incident to a coin flip.
    const ambiguous: CandidateCommit[] = [
      { ...candidates[0]!, sha: `0c70abc${"1".repeat(33)}` },
      { ...candidates[1]!, sha: `0c70abc${"2".repeat(33)}` },
    ];

    const result = groundCorrelation(answer({ suspectedCommitSha: "0c70abc" }), ambiguous);
    expect(result.ok).toBe(false);
  });

  it("treats a null sha as grounded by definition", () => {
    const result = groundCorrelation(
      answer({ suspectedCommitSha: null, changedFilesImplicated: [] }),
      candidates,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grounded.sha).toBeNull();
  });

  it("drops files named alongside a null sha, since no commit owns them", () => {
    const result = groundCorrelation(
      answer({ suspectedCommitSha: null, changedFilesImplicated: ["src/lib/pricing.js"] }),
      candidates,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounded.implicatedFiles).toEqual([]);
      expect(result.grounded.droppedFiles).toEqual(["src/lib/pricing.js"]);
    }
  });

  it("drops an invented file without failing the correlation", () => {
    // Not fatal: the sha still points at a real diff a human can open.
    const result = groundCorrelation(
      answer({ changedFilesImplicated: ["src/lib/pricing.js", "src/lib/invented.js"] }),
      candidates,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounded.implicatedFiles).toEqual(["src/lib/pricing.js"]);
      expect(result.grounded.droppedFiles).toEqual(["src/lib/invented.js"]);
    }
  });

  it("drops a file that belongs to a different candidate", () => {
    // The subtlest case: a real path, in the packet, but not in this commit.
    // Accepting it would let the model blur two commits into one claim.
    const result = groundCorrelation(
      answer({
        suspectedCommitSha: DECOY.slice(0, 10),
        changedFilesImplicated: ["src/lib/pricing.js", "src/routes/orders.js"],
      }),
      candidates,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounded.implicatedFiles).toEqual(["src/lib/pricing.js"]);
      expect(result.grounded.droppedFiles).toEqual(["src/routes/orders.js"]);
    }
  });

  it("reports an empty candidate list in the rejection message", () => {
    const result = groundCorrelation(answer(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0 candidate(s)");
  });
});
