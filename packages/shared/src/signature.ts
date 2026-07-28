/**
 * Error-signature normalisation.
 *
 * Two log lines that describe the same failure rarely match byte-for-byte —
 * they differ by request id, row id, timestamp, or a quoted value. Stripping
 * that variable detail collapses them onto a stable signature, which is what
 * makes "have we ever seen this error before?" a cheap set-membership check
 * instead of a fuzzy-matching problem.
 *
 * This powers the Tier 1 new-error-signature detector, which is the one
 * statistical detector that can catch a brand-new failure on its very first
 * occurrence — before it has had time to become a spike.
 */

const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  // UUIDs must go before the generic number rule, or their digits get eaten first.
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<uuid>",
  ],
  // ISO-8601 timestamps
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<timestamp>"],
  // Hex literals and long hex blobs (object ids, hashes)
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b[0-9a-f]{12,}\b/gi, "<hex>"],
  // Quoted values — usually the specific bad input, not the failure mode
  [/'[^']*'/g, "<str>"],
  [/"[^"]*"/g, "<str>"],
  // Absolute filesystem paths collapse to their basename
  [/(?:\/[\w.-]+){2,}/g, "<path>"],
  /**
   * Any remaining number (ids, counts, durations, ports).
   *
   * Note the deliberate absence of a trailing \b: a unit suffix like the "ms"
   * in "after 3000ms" is a word character, so requiring a boundary there would
   * leave the digits untouched and make "3000ms" and "5000ms" two distinct
   * signatures — the exact false-novelty this function exists to prevent.
   * The leading \b still protects embedded digits in identifiers ("utf8",
   * "ipv4"), because there is no boundary inside a word.
   */
  [/\b\d+(?:[.,]\d+)*/g, "<num>"],
];

const MAX_SIGNATURE_LENGTH = 512;

export function normalizeErrorSignature(message: string): string {
  let signature = message;
  for (const [pattern, replacement] of REPLACEMENTS) {
    signature = signature.replace(pattern, replacement);
  }
  return signature.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_LENGTH);
}
