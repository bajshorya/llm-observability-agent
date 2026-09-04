/**
 * The correlation golden set — loading, validating and saving labelled cases.
 *
 * WHAT THIS FILE DOES
 * The Phase 3 counterpart to `cases.ts`. Same design decisions, one different
 * label shape, and one property the classifier set does not have.
 *
 * WHAT A CASE CONTAINS
 *   name, scenario, capturedAt   provenance
 *   expect.suspectedCommitSha    the full sha, or null for "no commit"
 *   expect.implicatedFiles       paths that should be named, if any
 *   expect.note                  WHY that is the right answer, for humans
 *   context                      the entire rendered prompt, as a string
 *
 * `context` IS A STORED STRING, FOR THE SAME REASON AS THE CLASSIFIER SET
 * Storing a structured input and re-rendering at eval time measures whatever
 * the renderer does today. A stored string is a fixed artefact of one real
 * pipeline run, so scores are comparable across prompt and packet versions.
 *
 * THE PROPERTY THIS SET HAS THAT THE CLASSIFIER SET DOES NOT
 * A correlation case is SELF-CONTAINED. The prompt names its candidate commits
 * and the label names one of them, so scoring needs no repository at all —
 * `fixtures/orders-api` does not have to exist, or match, at eval time.
 *
 * That matters because the fixture is generated. `build-fixture-repo.sh` pins
 * its shas to an anchor date, and capturing a case requires a fixture whose
 * history overlaps freshly generated traffic, which means `--anchor now` and
 * therefore different shas per capture. Because the case carries both halves,
 * that is harmless: the stored prompt and the stored answer come from the same
 * moment and stay consistent with each other forever.
 *
 * WHY THE EXPECTED SHA IS STORED IN FULL
 * The packet renders 10 characters and the schema accepts 7 to 40, so a model
 * may answer with any prefix. Storing the full sha means the scorer compares
 * prefixes against one canonical value rather than against whatever width
 * happened to be captured.
 *
 * WHY HALF THE SET ANSWERS null
 * A set where every case has a culprit cannot distinguish a correlator from a
 * model that always names something — which is what a model with no way to
 * decline will do. This is the same argument that makes half the classifier
 * set benign, one tier along, and it is the reason `suspectedCommitSha` is
 * nullable at all.
 *
 * WHY MORE THAN ONE CASE HAS A CULPRIT, AND WHY THEY DIFFER
 * With a single attributable incident, "finds the guilty commit" and "has
 * learned the answer is the pricing one" produce identical scores. The
 * attributable cases therefore point at DIFFERENT commits in the fixture —
 * which is why `limiter-misconfig` exists in the generator.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CORRELATION_CASES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "correlation-cases",
);

export const correlationCaseSchema = z.object({
  name: z.string().min(1),
  /** The generator scenario this was captured from. */
  scenario: z.string().min(1),
  capturedAt: z.string(),
  expect: z.object({
    /**
     * The full 40-character sha, or null when no commit in the packet explains
     * the incident. Full rather than abbreviated so the scorer has one
     * canonical value to compare prefixes against.
     */
    suspectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    /**
     * Paths that a correct answer should name. Empty is a valid label and is
     * NOT the same as "any answer will do" — see `score-correlation.ts`, which
     * only scores this axis when the label is non-empty.
     */
    implicatedFiles: z.array(z.string()).default([]),
    /** Why this is the right answer. Read by humans, not by the scorer. */
    note: z.string(),
  }),
  /** The exact user prompt the correlator receives. */
  context: z.string().min(1),
});

export type CorrelationCase = z.infer<typeof correlationCaseSchema>;

/**
 * Cases in the experimental with-hunks arm. Excluded from the default set
 * because blending two packet formats into one scorecard would report a number
 * that describes neither. See `DOCUMENTATION-EVALS.md` §14.
 */
const DIFF_ARM_PREFIX = "diff-";

export function loadCorrelationCases(filter?: string, arm: "default" | "diff" = "default"): CorrelationCase[] {
  let files: string[];
  try {
    files = readdirSync(CORRELATION_CASES_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  const cases = files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(CORRELATION_CASES_DIR, file), "utf8"));
    const parsed = correlationCaseSchema.safeParse(raw);

    if (!parsed.success) {
      /**
       * Loud, with the field named. A case missing its expected sha would
       * otherwise score as `undefined !== "abc..."` — a silent wrong answer
       * recorded against the model, which is the worst thing a benchmark can
       * quietly do.
       */
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`${file} is not a valid correlation case — ${issues}`);
    }

    return parsed.data;
  });

  // A named case is returned whichever arm it belongs to, so `--case
  // diff-latency-jump` still works without also passing an arm flag.
  const inArm = filter
    ? cases.filter((c) => c.name === filter)
    : cases.filter((c) =>
        arm === "diff"
          ? c.name.startsWith(DIFF_ARM_PREFIX)
          : !c.name.startsWith(DIFF_ARM_PREFIX),
      );

  return inArm.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveCorrelationCase(golden: CorrelationCase): string {
  const path = join(CORRELATION_CASES_DIR, `${golden.name}.json`);
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  return path;
}
