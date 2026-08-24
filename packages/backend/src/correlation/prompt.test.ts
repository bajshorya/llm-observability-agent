/**
 * Tests for the correlator prompt.
 *
 * Not tests of wording — a prompt's quality is measured by an eval, not
 * asserted by a unit test. These guard one specific regression that an eval
 * cannot catch, because it makes the eval itself meaningless.
 *
 * THE REGRESSION
 * The obvious way to raise a correlation score is to put an example in the
 * prompt: name the file, quote the error, describe the shape of the answer. It
 * works, and it invalidates every number the harness produces afterwards,
 * because the system is then being told what to find rather than finding it.
 *
 * `CLAUDE.md` states the rule ("do not tune the prompt against the eval") and
 * the classifier prompt has honoured it byte-for-byte since before its first
 * real run. A rule that lives only in a document survives exactly as long as
 * the next person who has not read it, so this file makes it fail CI instead.
 *
 * The markers below are literals rather than reads of `fixtures/orders-api`,
 * because the test stays pure and because the fixture is gitignored — a test
 * that shells out to a repository that may not exist is a flaky test.
 */

import { describe, expect, it } from "vitest";
import { CORRELATOR_SYSTEM_PROMPT } from "./prompt";

/**
 * Anything from the fixture that would hand the model its answer. Add to this
 * list, never remove from it.
 */
const FIXTURE_LEAKS = [
  "toFixed",
  "pricing.js",
  "formatPrice",
  "formatDiscountedPrice",
  "discounted_cents",
  "discounted_total",
  "orders-api",
  "rateLimit.js",
  "reconcile",
  "orders-db",
];

describe("CORRELATOR_SYSTEM_PROMPT", () => {
  it("names nothing from the fixture repository", () => {
    for (const leak of FIXTURE_LEAKS) {
      expect(
        CORRELATOR_SYSTEM_PROMPT.toLowerCase(),
        `the prompt contains "${leak}", which is from the fixture the eval scores against`,
      ).not.toContain(leak.toLowerCase());
    }
  });

  it("contains no commit sha", () => {
    // Requires a digit, so ordinary words made only of a-f ("decade", "facade")
    // do not trip it. A sha with no digit at all would slip through; that is an
    // accepted gap, since the named-marker check above is the real guard.
    const shaLike = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;
    expect(shaLike.test(CORRELATOR_SYSTEM_PROMPT)).toBe(false);
  });

  it("uses no worked example at all", () => {
    // A generic example is a subtler version of the same failure: it teaches
    // the shape of the expected answer rather than asking for one.
    expect(CORRELATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("for example");
    expect(CORRELATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("e.g.");
  });

  it("asks for every field the schema requires", () => {
    for (const field of [
      "suspectedCommitSha",
      "confidence",
      "reasoning",
      "changedFilesImplicated",
    ]) {
      expect(CORRELATOR_SYSTEM_PROMPT).toContain(field);
    }
  });

  it("tells the model that null is a real answer", () => {
    // The single most load-bearing instruction in the file: a model with no
    // null available invents one, which is why the schema allows it.
    expect(CORRELATOR_SYSTEM_PROMPT).toContain("null");
    expect(CORRELATOR_SYSTEM_PROMPT.toLowerCase()).toContain("best of a bad set");
  });

  it("does not tell the model to ignore timing", () => {
    // Overshooting "recency is not guilt" is its own failure mode. Recency is
    // evidence; the error is treating it as sufficient. See the file header.
    expect(CORRELATOR_SYSTEM_PROMPT.toLowerCase()).toContain("timing narrows the field");
  });
});
