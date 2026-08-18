/**
 * The grounding check — did the model invent the location it named?
 *
 * WHAT THIS FILE DOES
 * One pure function, `checkGrounding(affectedArea, context)`, answering whether
 * the area a model named is actually supported by the evidence it was shown.
 *
 * WHY IT EXISTS
 * A specific observed failure. Asked to classify a window whose endpoints were
 * `/orders`, `/orders/:id` and `/orders/:id/refund`, a model answered
 * `"/orders/checkout path"`. Verdict right, severity right — and the one field
 * naming WHERE was confidently fabricated out of nothing.
 *
 * The prompt explicitly offers "unknown" for this case. So the question worth
 * measuring is whether a model takes that option or fills the space, and that
 * turns out to be mechanically checkable.
 *
 * THE RULES, IN ORDER
 *
 * 1. DECLINING COUNTS AS GROUNDED. "unknown", "n/a" or empty passes. A model
 *    saying "I cannot tell" when the evidence is thin is doing exactly what it
 *    was told, and scoring that as failure would push the prompt in precisely
 *    the wrong direction — toward confident guessing.
 *
 * 2. IF IT NAMES A PATH, THE PATH MUST APPEAR VERBATIM. A path is the
 *    highest-signal thing an area can contain and the easiest to fabricate, so
 *    it is checked strictly. Trailing punctuation is stripped, because
 *    `/orders/:id` and `/orders/:id.` are the same claim.
 *
 * 3. OTHERWISE, VOCABULARY OVERLAP. At least 60% of words of four or more
 *    characters must appear in the evidence. So "postgres connection pool"
 *    passes if the logs discuss those things, and "kafka consumer lag on
 *    billing" does not. Short words are dropped because "the" and "pool" carry
 *    very different evidential weight.
 *
 * WHY IT IS DELIBERATELY DUMB
 * The obvious alternative is an LLM judge — and that means a model grading a
 * model, which is unfalsifiable in exactly the way this project tries to avoid.
 * A crude check whose failures you can reason about beats a sophisticated one
 * you have to trust.
 *
 * WHAT IT CANNOT CATCH
 * A plausible invention that reuses vocabulary already in the evidence. It
 * catches confident fabrication, not subtle misattribution.
 */

/** Fraction of an area's significant words that must appear in the evidence. */
const WORD_OVERLAP_THRESHOLD = 0.6;
const MIN_WORD_LENGTH = 4;

const PATH_PATTERN = /\/[A-Za-z0-9:_\-/]+/g;

export interface GroundingResult {
  grounded: boolean;
  /** Human-readable reason, shown for failures. */
  reason: string;
}

export function checkGrounding(affectedArea: string, context: string): GroundingResult {
  const area = affectedArea.trim().toLowerCase();
  const haystack = context.toLowerCase();

  /**
   * Taking the escape hatch counts as grounded. A model that says "unknown"
   * when the evidence is thin is behaving exactly as instructed, and scoring
   * that as a failure would train the prompt in the wrong direction.
   */
  if (area === "" || area === "unknown" || area === "n/a") {
    return { grounded: true, reason: "declined to name an area" };
  }

  /**
   * A path is the highest-signal thing an area can contain, and the easiest to
   * fabricate — so when one is present it is checked strictly. Trailing
   * punctuation is stripped; `/orders/:id` and `/orders/:id.` are the same
   * claim.
   */
  const paths = (area.match(PATH_PATTERN) ?? []).map((path) => path.replace(/[.,;:]+$/, ""));

  if (paths.length > 0) {
    const missing = paths.filter((path) => !haystack.includes(path));
    return missing.length === 0
      ? { grounded: true, reason: `path ${paths.join(", ")} appears in the evidence` }
      : { grounded: false, reason: `path ${missing.join(", ")} appears nowhere in the evidence` };
  }

  /**
   * No path, so fall back to vocabulary. A prose area like "postgres connection
   * pool" is grounded if the evidence talks about those things. Short words are
   * dropped because "the" and "pool" carry very different amounts of evidence.
   */
  const words = area
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH);

  if (words.length === 0) {
    return { grounded: false, reason: `"${affectedArea}" says nothing checkable` };
  }

  const present = words.filter((word) => haystack.includes(word));
  const ratio = present.length / words.length;

  return ratio >= WORD_OVERLAP_THRESHOLD
    ? { grounded: true, reason: `${present.length}/${words.length} terms appear in the evidence` }
    : {
        grounded: false,
        reason: `only ${present.length}/${words.length} terms appear in the evidence`,
      };
}
