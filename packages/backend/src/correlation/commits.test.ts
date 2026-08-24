/**
 * Tests for the `git log` parser.
 *
 * Every case here is a string, because `parseGitLog` is pure — no repository,
 * no filesystem, no subprocess. That is the point of the split: the cases that
 * matter most are the ones that are hardest to produce on demand in a real
 * repo, and trivial to write down as text.
 *
 * The separator cases are not hypothetical politeness. A commit message
 * containing a control character is rare, but a parser that breaks on one
 * fails by MIS-ATTRIBUTING a cause, not by crashing — and this project's whole
 * claim is that its answers are checkable.
 */

import { describe, expect, it } from "vitest";
import { GIT_LOG_FORMAT, parseGitLog } from "./commits";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** Build the stdout git would produce, using the real separators. */
function record(
  sha: string,
  iso: string,
  author: string,
  subject: string,
  body: string,
  numstat = "",
): string {
  return `\x1e${sha}\x1f${iso}\x1f${author}\x1f${subject}\x1f${body}\x1e\n${numstat}`;
}

describe("parseGitLog", () => {
  it("returns nothing for empty output", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\n")).toEqual([]);
  });

  it("parses a single commit with its files", () => {
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "orders-api ci",
      "feat(pricing): show the promotional total",
      "Adds discounted_total to every order response.\n",
      "7\t1\tsrc/lib/pricing.js\n2\t1\tsrc/routes/orders.js\n",
    );

    const [commit] = parseGitLog(stdout);

    expect(commit).toBeDefined();
    expect(commit?.sha).toBe(SHA_A);
    expect(commit?.author).toBe("orders-api ci");
    expect(commit?.subject).toBe("feat(pricing): show the promotional total");
    expect(commit?.body).toBe("Adds discounted_total to every order response.");
    expect(commit?.committedAt.toISOString()).toBe("2026-08-16T17:25:00.000Z");
    expect(commit?.files).toEqual([
      { path: "src/lib/pricing.js", added: 7, deleted: 1 },
      { path: "src/routes/orders.js", added: 2, deleted: 1 },
    ]);
  });

  it("keeps git's newest-first order across multiple commits", () => {
    const stdout =
      record(SHA_A, "2026-08-16T18:20:00+00:00", "ci", "chore(ci): cache the store", "") +
      record(SHA_B, "2026-08-16T17:25:00+00:00", "ci", "feat(pricing): the bug", "");

    expect(parseGitLog(stdout).map((c) => c.sha)).toEqual([SHA_A, SHA_B]);
  });

  it("survives a body containing the field separator", () => {
    // The reason the format brackets each header with \x1e rather than keying
    // on newlines: a body is arbitrary text and may contain anything.
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "ci",
      "fix: handle control characters",
      `A body with a \x1f unit separator in it.\n\nAnd a blank line.\n`,
      "1\t0\tsrc/lib/pricing.js\n",
    );

    const [commit] = parseGitLog(stdout);
    expect(commit?.subject).toBe("fix: handle control characters");
    expect(commit?.files).toHaveLength(1);
  });

  it("survives a multi-paragraph body with blank lines", () => {
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "ci",
      "perf(db): index orders.created_at",
      "The list route sorts on every request.\n\nCONCURRENTLY so it takes no write lock.\n",
      "4\t0\tmigrations/002.sql\n",
    );

    const [commit] = parseGitLog(stdout);
    expect(commit?.body).toContain("CONCURRENTLY");
    expect(commit?.files).toEqual([{ path: "migrations/002.sql", added: 4, deleted: 0 }]);
  });

  it("reports a binary file's line counts as null, not zero", () => {
    // `-` means the count does not exist. Zero would be a measurement, and a
    // claim that the file did not really change.
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "ci",
      "chore: add the logo",
      "",
      "-\t-\tpublic/logo.png\n3\t1\tsrc/server.js\n",
    );

    expect(parseGitLog(stdout)[0]?.files).toEqual([
      { path: "public/logo.png", added: null, deleted: null },
      { path: "src/server.js", added: 3, deleted: 1 },
    ]);
  });

  it("accepts a path containing a tab", () => {
    // Only the first two tabs delimit; the rest belong to the path.
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "ci",
      "chore: rename",
      "",
      "1\t1\tsrc/odd\tname.js\n",
    );

    expect(parseGitLog(stdout)[0]?.files).toEqual([
      { path: "src/odd\tname.js", added: 1, deleted: 1 },
    ]);
  });

  it("accepts a commit that touches no files", () => {
    const stdout = record(SHA_A, "2026-08-16T17:25:00+00:00", "ci", "chore: empty", "");
    expect(parseGitLog(stdout)[0]?.files).toEqual([]);
  });

  it("accepts an empty body", () => {
    const stdout = record(SHA_A, "2026-08-16T17:25:00+00:00", "ci", "test: cover routes", "");
    expect(parseGitLog(stdout)[0]?.body).toBe("");
  });

  it("throws rather than skipping a malformed record", () => {
    // Dropping the record would produce a correlation over a history with a
    // hole in it, and the answer would look exactly as confident as a good one.
    const truncated = `\x1e${SHA_A}\x1f2026-08-16T17:25:00+00:00\x1fci\x1e\n`;
    expect(() => parseGitLog(truncated)).toThrow(/expected 5 fields/);
  });

  it("fails loudly on a record separator inside a body, rather than mis-parsing", () => {
    // The residual case the format cannot defend against. What matters is that
    // it surfaces as an error and not as a commit attributed to the wrong sha.
    const stdout = record(
      SHA_A,
      "2026-08-16T17:25:00+00:00",
      "ci",
      "fix: pathological message",
      "A body with a \x1e record separator in it.",
      "1\t0\tsrc/lib/pricing.js\n",
    );

    // Which of the two guards fires depends on where the stray separator
    // lands; that it throws at all is the property worth holding.
    expect(() => parseGitLog(stdout)).toThrow(/unparseable numstat|does not begin with a sha/);
  });

  it("throws on an unparseable date", () => {
    const stdout = record(SHA_A, "not-a-date", "ci", "chore: x", "");
    expect(() => parseGitLog(stdout)).toThrow(/unparseable date/);
  });

  it("throws on a short sha, which no longer identifies a commit uniquely", () => {
    const stdout = record("abc1234", "2026-08-16T17:25:00+00:00", "ci", "chore: x", "");
    expect(() => parseGitLog(stdout)).toThrow();
  });

  it("throws on a numstat line missing its columns", () => {
    const stdout = record(SHA_A, "2026-08-16T17:25:00+00:00", "ci", "chore: x", "", "1 0 f.js\n");
    expect(() => parseGitLog(stdout)).toThrow(/unparseable numstat/);
  });
});

describe("GIT_LOG_FORMAT", () => {
  it("brackets each record and separates five fields", () => {
    // The parser's alternating-chunk assumption depends on both separators
    // being present exactly this many times. A change to one without the other
    // would otherwise be caught only at runtime, against a real repository.
    expect(GIT_LOG_FORMAT.match(/%x1e/g)).toHaveLength(2);
    expect(GIT_LOG_FORMAT.match(/%x1f/g)).toHaveLength(4);
  });
});
