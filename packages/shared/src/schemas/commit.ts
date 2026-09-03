/**
 * Source-history input for Phase 3 — what a candidate commit looks like.
 *
 * WHAT THIS FILE DOES
 * Defines the shape of a commit as the correlation agent sees it. This is the
 * SECOND data source in the system: everything before it describes runtime
 * behaviour, and correlation is the step that reasons across both. That is
 * what makes the pipeline agentic rather than a wrapper — two independent
 * sources, one causal conclusion.
 *
 * WHY THIS IS A VALIDATED BOUNDARY AND NOT JUST A TYPE
 * `git log` output is text from a subprocess. It is parsed, and parsers are
 * wrong in ways that are invisible until a field renders as `undefined` three
 * functions later — a body containing the field separator, a commit with no
 * files, a binary file whose numstat columns are `-` rather than integers.
 * Validating here means a malformed parse fails loudly at the boundary, on the
 * same principle as every other edge in this system.
 *
 * WHAT IT EXPORTS
 *   - `changedFileSchema`     path, lines added, lines deleted
 *   - `candidateCommitSchema` sha, timestamp, author, subject, body, files
 *   - `commitWindowSchema`    the set of commits considered for one anomaly
 *
 * NOTES ON PARTICULAR FIELDS
 * `added`/`deleted` are NULLABLE, not defaulted to zero. `git log --numstat`
 * prints `-` for a binary file, and a binary asset with "0 lines changed" is a
 * different claim from one whose line count is unknowable. Zero is a
 * measurement; null is the absence of one.
 *
 * `subject` and `body` are kept apart rather than stored as one message blob.
 * They carry different weight as evidence: the subject is what a developer
 * chose as the one-line claim, the body is where the reasoning and the
 * trade-off live. The prompt renders them differently for that reason.
 *
 * `diff` was added after the correlation eval showed why it was missing. The
 * packet originally carried per-file line counts and no hunks, which meant an
 * innocent commit touching the affected path could not be ruled OUT: `+2/-1` in
 * a route handler could be a string format or a synchronous network call.
 * Every model tested attributed a latency incident to such a commit. See
 * `DOCUMENTATION-EVALS.md` §14.
 *
 * `sha` is the full 40 characters. Short shas are for display and are
 * ambiguous by construction; the model is asked to return one of the shas it
 * was given, and `correlationSchema.suspectedCommitSha` accepts 7 to 40 so a
 * model that abbreviates is not rejected for it.
 */

import { z } from "zod";

/**
 * One file touched by a commit. Line counts are nullable because
 * `git log --numstat` reports `-` for binary files.
 */
export const changedFileSchema = z.object({
  path: z.string().min(1).max(400),
  /** Null for a binary file, where a line count does not exist. */
  added: z.number().int().nonnegative().nullable(),
  deleted: z.number().int().nonnegative().nullable(),
});

export type ChangedFile = z.infer<typeof changedFileSchema>;

/**
 * A commit offered to the correlation agent as a possible cause.
 *
 * "Candidate" is the operative word: being in this list is not evidence of
 * guilt. Most windows are explained by no commit at all, which is why
 * `correlationSchema.suspectedCommitSha` is nullable.
 */
export const candidateCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-character sha"),
  committedAt: z.date(),
  author: z.string().max(200),
  subject: z.string().max(500),
  /** Empty string when the commit has no body; most trivial commits do not. */
  body: z.string().max(4000),
  /** A commit that touches nothing is legal (an empty commit) but suspicious. */
  files: z.array(changedFileSchema).max(200),
  /**
   * The unified diff, verbatim from `git log -p`, or empty when the commit
   * changed nothing.
   *
   * Stored unbudgeted on purpose: the collector's job is to report what git
   * said, and deciding how much of it a model should see is the renderer's.
   * That split is the same one that keeps `context.ts` the only place a
   * budget lives.
   */
  diff: z.string().default(""),
});

export type CandidateCommit = z.infer<typeof candidateCommitSchema>;

/**
 * The commits considered for one anomaly, newest first.
 *
 * The window is part of the contract because "which commits were even looked
 * at" is not recoverable from the answer. A correlation that names nothing is
 * only meaningful if you know whether it was choosing from twelve commits or
 * from none.
 */
export const commitWindowSchema = z.object({
  /** Newest first — the order the prompt renders them in. */
  commits: z.array(candidateCommitSchema).max(100),
  /** Inclusive lower bound of the lookback. */
  since: z.date(),
  /** Exclusive upper bound — normally the end of the anomaly window. */
  until: z.date(),
});

export type CommitWindow = z.infer<typeof commitWindowSchema>;
