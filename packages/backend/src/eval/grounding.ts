/**
 * Is `affectedArea` supported by the evidence, or did the model invent it?
 *
 * This check exists because of a specific observed failure. Asked to classify a
 * window whose endpoints were `/orders`, `/orders/:id` and
 * `/orders/:id/refund`, a small model answered `"/orders/checkout path"`. The
 * verdict and severity were both right; the one field naming *where* was
 * confidently fabricated. The prompt tells the model to answer "unknown" when
 * the evidence does not identify an area, and the interesting question is
 * whether it takes that option or fills the space.
 *
 * That is mechanically checkable — no judgement, no second model grading a
 * first one. If the area names a path, the path has to appear in what the model
 * was shown.
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
