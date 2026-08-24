/**
 * Checking a correlation against the evidence it was given — PURE.
 *
 * WHAT THIS FILE DOES
 * Takes what the model returned and the commits it was actually shown, and
 * decides whether the answer is grounded in them. No database, no clock, no
 * network. The impure half is `correlate.ts`.
 *
 * WHY THIS EXISTS AT ALL
 * `correlationSchema` already guarantees the answer is well-FORMED: a string of
 * 7–40 characters, a confidence in range, a reasoning of sensible length. It
 * cannot guarantee the answer is TRUE to the evidence, because it has never
 * seen the evidence. `"deadbeef"` is a perfectly valid sha and may correspond
 * to no commit in the candidate list, or to no commit anywhere.
 *
 * This is the correlation-stage counterpart to `eval/grounding.ts`, which asks
 * the same question of the classifier's `affectedArea`: does the answer refer
 * to something the model was actually shown, or did it invent it? The
 * difference is that this one runs in the PIPELINE, not only in the eval —
 * a hallucinated sha here would be written to `correlations` and inherited by
 * Phase 4's root-cause agent as established fact.
 *
 * TWO KINDS OF UNGROUNDED ANSWER, TREATED DIFFERENTLY
 *
 *   AN INVENTED SHA is fatal. The causal claim is the sha; if it names nothing
 *   in the candidate list then there is no claim, only a plausible-looking
 *   string. Coercing it to null would be worse than failing, because "no commit
 *   explains this" is a real finding and this is not one — recording a
 *   hallucination as a considered null would corrupt the very measurement the
 *   nullable field exists to make possible.
 *
 *   AN INVENTED FILE is not. The sha still points at a real commit whose diff a
 *   human can open, so the answer remains checkable; the file list is
 *   supporting detail. Those paths are dropped and REPORTED rather than
 *   silently discarded, because a model inventing file paths is a signal about
 *   that model worth seeing in the output.
 *
 * WHY PREFIXES ARE RESOLVED HERE
 * The packet renders 10-character shas and the schema accepts 7–40, so the
 * answer usually needs expanding back to the full 40 before it is stored.
 * Doing that by prefix match against the candidate list — rather than by
 * asking git — means resolution cannot succeed for a commit the model was
 * never shown. The lookup and the grounding check are the same operation.
 *
 * An ambiguous prefix matching two candidates is treated as ungrounded rather
 * than resolved to the first. Two commits sharing a 7-character prefix in a
 * 25-commit window is vanishingly unlikely, and guessing between them would
 * attribute an incident to a coin flip.
 */

import type { CandidateCommit, Correlation } from "@obs/shared";

export interface GroundedCorrelation {
  /** The full 40-character sha, or null for a considered "no commit". */
  sha: string | null;
  /** Paths that exist in the named commit. */
  implicatedFiles: string[];
  /**
   * Paths the model named that the commit does not contain. Not fatal, but
   * reported — a model inventing paths is worth seeing.
   */
  droppedFiles: string[];
}

export type CorrelationGroundingResult =
  | { ok: true; grounded: GroundedCorrelation }
  | { ok: false; reason: string };

/**
 * Resolve a possibly-abbreviated sha against the candidates the model was
 * shown. Returns null when it matches none, and treats an ambiguous prefix as
 * a non-match — see the header.
 */
function resolveSha(answer: string, candidates: readonly CandidateCommit[]): string | null {
  const needle = answer.trim().toLowerCase();
  const matches = candidates.filter((commit) => commit.sha.startsWith(needle));

  return matches.length === 1 ? (matches[0]?.sha ?? null) : null;
}

/**
 * Check a model's correlation against the commits it was given.
 *
 * A null sha is grounded by definition — "no commit explains this" is an answer
 * about the whole list rather than about any member of it. Any files named
 * alongside a null sha are dropped, since there is no commit for them to belong
 * to; the prompt asks for an empty array there, and this is what happens when
 * that instruction is not followed.
 */
export function groundCorrelation(
  correlation: Correlation,
  candidates: readonly CandidateCommit[],
): CorrelationGroundingResult {
  if (correlation.suspectedCommitSha === null) {
    return {
      ok: true,
      grounded: {
        sha: null,
        implicatedFiles: [],
        droppedFiles: [...correlation.changedFilesImplicated],
      },
    };
  }

  const sha = resolveSha(correlation.suspectedCommitSha, candidates);

  if (sha === null) {
    // Fatal. See the header: coercing this to null would record a
    // hallucination as a considered finding.
    return {
      ok: false,
      reason:
        `the model named commit "${correlation.suspectedCommitSha}", which is not ` +
        `among the ${candidates.length} candidate(s) it was shown`,
    };
  }

  const commit = candidates.find((candidate) => candidate.sha === sha);
  const paths = new Set(commit?.files.map((file) => file.path) ?? []);

  const implicatedFiles: string[] = [];
  const droppedFiles: string[] = [];

  for (const path of correlation.changedFilesImplicated) {
    if (paths.has(path)) implicatedFiles.push(path);
    else droppedFiles.push(path);
  }

  return { ok: true, grounded: { sha, implicatedFiles, droppedFiles } };
}
