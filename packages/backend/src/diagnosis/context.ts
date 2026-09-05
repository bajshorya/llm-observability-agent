/**
 * Building the root-cause agent's evidence packet — PURE.
 *
 * WHAT THIS FILE DOES
 * Turns a confirmed incident, the commit correlation blamed, and that commit's
 * diff into the text sent to the model. Same discipline as the two packets
 * before it: same input, same text out, no clock, no database, no subprocess.
 *
 * THE DIFF IS MANDATORY HERE, NOT A TRADE
 * This is the one thing worth understanding about this stage. In correlation,
 * hunks are a measured trade — they help a capable model rule commits out and
 * they degrade a weak one, so `CORRELATION_DIFFS` is a switch and the default
 * is off (`DOCUMENTATION-EVALS.md` §14).
 *
 * Here there is nothing to trade. The question is "why did this change break,
 * and what is the fix", and neither half is answerable from a commit subject
 * and a line count. `src/lib/pricing.js +7/-1` cannot produce a patch. So the
 * diff is always included, and a commit whose diff could not be read is a
 * reason to refuse the stage rather than to guess.
 *
 * THE PACKET IS THREE THINGS, IN CAUSAL ORDER
 *
 *   THE SYMPTOM      what the service did — severity, area, the raw error text
 *   THE ATTRIBUTION  which commit was blamed, with what confidence and why
 *   THE CHANGE       that commit's subject, body and full diff
 *
 * The correlator's own reasoning is included deliberately. Without it this
 * stage would silently re-derive the attribution, and two stages quietly
 * answering the same question is how a pipeline stops being auditable — the
 * whole point of separating them is that each conclusion has one owner.
 *
 * Including it costs something honest: the model is told what to believe about
 * causation before it reads the code. That is why the prompt asks it to say so
 * when the diff does NOT explain the failure, and why `explainsTheFailure`
 * exists in the schema. A stage that can only agree with its input is not a
 * stage.
 *
 * WHY THE RAW ERROR TEXT IS CARRIED AGAIN
 * Same reason as the correlation packet: normalisation is what makes the
 * new-signature detector work and what makes this stage harder. `reading
 * '<str>'` cannot be matched against a line of code; `reading 'toFixed'` can.
 *
 * NO BUDGET ON THE DIFF
 * Every other packet in this system truncates. This one does not, because a
 * root cause found in the truncated half is a root cause missed, and this stage
 * runs on at most one commit for at most one incident — the funnel has already
 * narrowed four times by the time anything reaches it. If a commit is large
 * enough for that to matter, the right answer is a smaller commit.
 */

import type { AnomalyTrigger, CandidateCommit, Severity } from "@obs/shared";
import { describeTrigger } from "../classification/context";

export interface DiagnosisInput {
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: readonly AnomalyTrigger[];
  /** Tier 2's verdict. Settled upstream; this stage does not revisit it. */
  severity: Severity;
  summary: string;
  affectedArea: string;
  /** The commit Phase 3 blamed, with its full diff. */
  commit: CandidateCommit;
  /** Why Phase 3 blamed it, verbatim. */
  correlationReasoning: string;
  correlationConfidence: number;
  /** Files within that commit the correlator implicated, if any. */
  implicatedFiles: readonly string[];
}

/** `2026-08-16 17:25Z` — minute precision; commit seconds are noise here. */
const stamp = (date: Date): string =>
  `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Cap on the raw error sample only. The diff is deliberately uncapped. */
const MAX_ERROR_CHARS = 300;

export function renderDiagnosisContext(input: DiagnosisInput): string {
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

  sections.push(
    ["What the classification stage concluded:", `  ${input.summary}`].join("\n"),
  );

  // Verbatim, and un-normalised where it matters — see the header.
  sections.push(
    [
      "What the detectors found:",
      ...input.triggers.flatMap((trigger) => {
        const described = `- ${describeTrigger(trigger)}`;
        return trigger.kind === "new_error_signature"
          ? [described, `    raw example: ${truncate(trigger.sampleMessage, MAX_ERROR_CHARS)}`]
          : [described];
      }),
    ].join("\n"),
  );

  const files = input.implicatedFiles.length > 0
    ? input.implicatedFiles.join(", ")
    : "(none named)";

  sections.push(
    [
      "What the correlation stage concluded:",
      `  Commit ${input.commit.sha.slice(0, 10)} (confidence ${input.correlationConfidence.toFixed(2)})`,
      `  Files implicated: ${files}`,
      `  Reasoning: ${input.correlationReasoning}`,
    ].join("\n"),
  );

  const commitLines = [
    `The commit, in full:`,
    "",
    `  ${input.commit.sha.slice(0, 10)}  ${stamp(input.commit.committedAt)}  —  ${input.commit.author}`,
    `    ${input.commit.subject}`,
  ];

  if (input.commit.body) {
    for (const line of input.commit.body.split("\n")) commitLines.push(`      ${line}`);
  }

  commitLines.push(`    files (${input.commit.files.length}):`);
  for (const file of input.commit.files) {
    const change =
      file.added === null || file.deleted === null ? "binary" : `+${file.added}/-${file.deleted}`;
    commitLines.push(`      ${file.path}  ${change}`);
  }

  if (input.commit.diff) {
    commitLines.push("", "    diff:");
    // Indented as a block so a patch's own `---` and `+++` markers cannot be
    // read as structure belonging to the packet.
    for (const line of input.commit.diff.split("\n")) commitLines.push(`      ${line}`);
  } else {
    /**
     * Stated rather than left blank. An empty diff section would read as "this
     * commit changed nothing", which is a different and much stronger claim
     * than "the diff could not be read".
     */
    commitLines.push("", "    diff: UNAVAILABLE — the patch for this commit could not be read.");
  }

  sections.push(commitLines.join("\n"));

  return sections.join("\n\n");
}
