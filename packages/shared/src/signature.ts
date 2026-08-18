/**
 * Error-signature normalisation — turning many raw messages into one stable key.
 *
 * WHAT THIS FILE DOES
 * Exports a single function, `normalizeErrorSignature`, which takes a raw log
 * message and strips out every part that varies between occurrences of the same
 * failure: uuids, timestamps, hex blobs, quoted values, file paths, and plain
 * numbers. What comes back is a template.
 *
 *     "Order 12778 not found"  ─┐
 *     "Order 44012 not found"  ─┼──▶  "Order <num> not found"
 *     "Order 90311 not found"  ─┘
 *
 * WHY IT EXISTS
 * Two log lines describing the same failure almost never match byte-for-byte.
 * Collapsing them onto a shared key turns "have we ever seen this error
 * before?" from a fuzzy-matching problem into a set-membership check.
 *
 * WHERE IT IS USED
 *   1. At ingest (`routes/ingest.ts`), computed once per warn/error/fatal entry
 *      and stored on the row, so the new-signature detector is an indexed
 *      lookup rather than a regex pass over millions of rows at query time.
 *   2. By the Tier 1 `new_error_signature` detector — the only detector that
 *      catches a brand-new failure on its first occurrence, before it has had
 *      time to become a statistical spike.
 *   3. By the evidence sampler (`classification/context.ts`), which groups log
 *      lines by normalised shape so the model sees one example of each kind
 *      rather than twenty copies of the most common one.
 *
 * MEASURED EFFECT
 * In the seeded baseline, 87 distinct raw "Rate limit exceeded for client N"
 * messages collapse to one signature. Without this, the new-signature detector
 * would flag ~170 "novel" errors per minute of perfectly healthy traffic and be
 * useless.
 *
 * The rules below are ORDER-DEPENDENT — see the comments on each.
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
