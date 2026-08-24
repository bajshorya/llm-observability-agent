/**
 * Building the correlator's evidence packet — deciding what the model sees.
 *
 * WHAT THIS FILE DOES
 * Turns one classified incident plus a set of candidate commits into the text
 * sent to the model. Like its Tier 2 counterpart it is PURE: same input, same
 * prompt out, no clock, no database, no subprocess. Every date rendered here
 * comes from the input, which is why "how long before the window" is
 * reproducible rather than a function of when you ran it.
 *
 * THE PROBLEM IT SOLVES
 * This is the first packet in the system built from TWO sources. The classifier
 * reads one window and answers a question about that window. The correlator has
 * to hold a runtime symptom and a source change side by side and decide whether
 * one explains the other. Neither half contains the answer.
 *
 * So the packet is deliberately two halves with a seam down the middle:
 *
 *   THE INCIDENT     what broke, where, how badly, and — most usefully — the
 *                    exact text of the new error signature
 *   THE CANDIDATES   what changed, when relative to the breakage, by whom,
 *                    with what stated intent, touching which files
 *
 * WHAT CARRIES THE SIGNAL, IN PRACTICE
 * The single highest-value line in the whole packet is the raw error message
 * from `new_error_signature`. `Cannot read properties of null (reading
 * 'toFixed')` names an operation and a type, and a commit whose diff touches a
 * file about formatting money is a hypothesis a reader can check. That is why
 * the trigger descriptions are rendered verbatim rather than summarised — the
 * classifier's `summary` is a judgement, and judgements lose the detail that
 * makes correlation possible.
 *
 * NORMALISATION HELPS TIER 1 AND HURTS THIS ONE
 * `describeTrigger` prints the NORMALISED signature, because that is what the
 * new-signature detector actually compared against the baseline. Normalisation
 * is what makes that detector work: it collapses `reading 'toFixed'` and
 * `reading 'toUpperCase'` into one shape so a thousand ids do not look like a
 * thousand novel errors.
 *
 * For correlation it removes the one token that points at code. `reading
 * '<str>'` matches nothing in a repository; `reading 'toFixed'` matches a file
 * about formatting money. So the raw sample is printed alongside the
 * normalised form rather than instead of it — the shape says how the detector
 * saw it, the sample says what actually happened. This packet was written
 * without the raw line first, and its own test caught it.
 *
 * The classifier's verdict is included anyway, for a different reason: it says
 * what was already concluded, so the correlator is not silently re-litigating
 * whether this is an incident at all. That question is answered upstream.
 *
 * THE BUDGET
 * 25 commits, 12 files per commit, 400 chars of body, 200 of subject. Commits
 * are the expensive axis — the collector already caps them at 25, and this cap
 * exists so a wider `--lookback` cannot silently produce a 40-commit prompt.
 *
 * WHY AGE IS RENDERED, NOT JUST THE TIMESTAMP
 * "1h 35m before the window" is the causal question stated directly; "2026-08-16
 * 17:25Z" makes the reader compute it. Both are printed, because the absolute
 * time is what a human checks the answer against, but the age is what the
 * reasoning actually turns on.
 *
 * TWO DECISIONS WORTH ARGUING WITH
 *
 * SHORT SHAS ARE RENDERED, NOT FULL ONES. A model copying 40 hex characters has
 * more chances to typo than one copying 10, and `correlationSchema` accepts 7
 * to 40 precisely so an abbreviation is not rejected. Orchestration resolves
 * the answer back against the candidate list, which also catches an invented
 * sha — the correlation-stage equivalent of the grounding check in `eval/`.
 *
 * COMMITS ARE RENDERED NEWEST FIRST, which is the order git prints them and the
 * order a developer reads them. It is also, uncomfortably, the order that
 * encourages the recency heuristic the fixture history exists to defeat. The
 * alternative — shuffling, or oldest-first — would be arranging the evidence to
 * influence the answer, which is a worse failure than the one it prevents. The
 * prompt is where "recent is not the same as guilty" belongs; the packet's job
 * is to present what is true in the form it is true in.
 *
 * NO DIFF CONTENT
 * Subjects, bodies and per-file line counts, not hunks. Hunks are the obvious
 * next increment and would roughly triple the packet. Worth doing only once
 * there is a measurement showing the line counts are not enough — which today
 * there is not, in either direction.
 */

import type { AnomalyTrigger, CandidateCommit, CommitWindow, Severity } from "@obs/shared";
import { describeTrigger } from "../classification/context";

/**
 * Context budget for the correlation packet. Smaller than it looks: a commit
 * with a body and eight files is already ~12 lines, so 25 of them is most of
 * the prompt.
 */
export const correlationBudget = {
  /**
   * Commits rendered. `defaultLookback.maxCommits` is also 25, so this is
   * normally slack — it exists so that widening the lookback cannot silently
   * produce a prompt nobody sized.
   */
  maxCommits: 25,
  /**
   * Files listed per commit. A refactor touching sixty files says "this was a
   * refactor" in its first twelve as clearly as in all sixty, and the count of
   * what was elided is printed so the scale is not lost.
   */
  maxFilesPerCommit: 12,
  /**
   * Body characters. The body is where the reasoning and the trade-off live,
   * which is exactly the evidence that distinguishes two commits touching the
   * same file — so this is generous relative to the log-line cap in Tier 2.
   */
  maxBodyChars: 400,
  maxSubjectChars: 200,
  /**
   * Raw error text. Generous, because this is the line the whole stage turns
   * on and a truncated stack frame is worth less than none.
   */
  maxErrorChars: 300,
} as const;

export interface CorrelationInput {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: readonly AnomalyTrigger[];
  /** Tier 2's verdict. Included so the correlator does not re-litigate it. */
  severity: Severity;
  summary: string;
  affectedArea: string;
  commits: CommitWindow;
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** `2026-08-16 17:25Z` — minute precision; commit seconds are noise here. */
const stamp = (date: Date): string =>
  `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;

/**
 * How long before the window a commit landed, as a human reads it.
 *
 * Rounded to whole minutes and never to a bare "0m": a commit inside the
 * anomaly window itself is a genuinely different situation from one before it,
 * and flattening the two would hide it. `--until` bounds the collector at the
 * window's end, so "during" is the closest anything gets.
 */
export function describeAge(committedAt: Date, windowEnd: Date): string {
  const minutes = Math.round((windowEnd.getTime() - committedAt.getTime()) / 60_000);

  if (minutes < 0) return "after the window ended";
  if (minutes === 0) return "as the window ended";

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  // Minutes are dropped once we are into days — "2d 4h 13m" is false precision.
  if (mins > 0 && days === 0) parts.push(`${mins}m`);

  return `${parts.join(" ")} before`;
}

/** `+7/-1`, or `binary` when git reported no line counts. */
function describeChange(added: number | null, deleted: number | null): string {
  if (added === null || deleted === null) return "binary";
  return `+${added}/-${deleted}`;
}

/**
 * One commit, as a block. The sha leads because it is what the model must
 * return, and the files close because they are what `changedFilesImplicated`
 * has to be drawn from.
 */
function renderCommit(commit: CandidateCommit, windowEnd: Date): string {
  const lines: string[] = [
    `  ${commit.sha.slice(0, 10)}  ${stamp(commit.committedAt)}  ` +
      `${describeAge(commit.committedAt, windowEnd)}  —  ${commit.author}`,
    `    ${truncate(commit.subject, correlationBudget.maxSubjectChars)}`,
  ];

  if (commit.body) {
    // Indented as a block so a multi-paragraph body cannot be mistaken for the
    // start of the next commit.
    for (const line of truncate(commit.body, correlationBudget.maxBodyChars).split("\n")) {
      lines.push(`      ${line}`);
    }
  }

  if (commit.files.length === 0) {
    // Legal, and worth saying out loud rather than rendering an empty section:
    // a commit that changed nothing cannot have broken anything.
    lines.push(`    files: (none — this commit changed no files)`);
  } else {
    const shown = commit.files.slice(0, correlationBudget.maxFilesPerCommit);
    const elided = commit.files.length - shown.length;

    lines.push(`    files (${commit.files.length}):`);
    for (const file of shown) {
      lines.push(`      ${file.path}  ${describeChange(file.added, file.deleted)}`);
    }
    if (elided > 0) lines.push(`      … and ${elided} more`);
  }

  return lines.join("\n");
}

/**
 * Render the correlation evidence packet.
 *
 * The empty-candidate case is stated explicitly rather than left as a missing
 * section. A section that is absent reads as "not provided"; the model needs to
 * know the difference between "we found nothing" and "we did not look", because
 * only one of those makes `null` the correct answer rather than a guess.
 */
export function renderCorrelationContext(input: CorrelationInput): string {
  const windowMinutes = Math.max(
    1,
    Math.round((input.windowEnd.getTime() - input.windowStart.getTime()) / 60_000),
  );

  const sections: string[] = [];

  sections.push(
    [
      `Service: ${input.service}`,
      `Window: ${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()} (${windowMinutes} min)`,
      `Severity: ${input.severity}`,
      `Affected area: ${input.affectedArea}`,
    ].join("\n"),
  );

  sections.push(["Already established by the classification stage:", `  ${input.summary}`].join("\n"));

  // Verbatim, not summarised — and un-normalised where it matters. See the
  // header on why the raw sample is printed next to the collapsed shape.
  sections.push(
    [
      "What the statistical detectors found:",
      ...input.triggers.flatMap((trigger) => {
        const described = `- ${describeTrigger(trigger)}`;
        return trigger.kind === "new_error_signature"
          ? [
              described,
              `    raw example: ${truncate(trigger.sampleMessage, correlationBudget.maxErrorChars)}`,
            ]
          : [described];
      }),
    ].join("\n"),
  );

  const { commits, since, until } = input.commits;

  if (commits.length === 0) {
    sections.push(
      [
        "Candidate commits: NONE.",
        `  No commit landed between ${since.toISOString()} and ${until.toISOString()}.`,
        "  The search ran and returned nothing; this is not missing data.",
      ].join("\n"),
    );
  } else {
    const shown = commits.slice(0, correlationBudget.maxCommits);
    const elided = commits.length - shown.length;

    sections.push(
      [
        `Candidate commits (${commits.length}), searched ${since.toISOString()} to ` +
          `${until.toISOString()}, newest first:`,
        "",
        shown.map((commit) => renderCommit(commit, input.windowEnd)).join("\n\n"),
        ...(elided > 0 ? ["", `  … and ${elided} older commits not shown`] : []),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
