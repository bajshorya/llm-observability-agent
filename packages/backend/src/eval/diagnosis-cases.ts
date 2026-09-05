/**
 * The diagnosis golden set — Phase 4's cases.
 *
 * WHY THIS EXISTS, HAVING BEEN CALLED IMPOSSIBLE
 * `DOCUMENTATION-PHASE-4.md` §10 recorded that Phase 4 had no eval because "is
 * this mechanism right" and "is this fix good" are not boolean, and the two
 * evals that work both hang on a question with an unambiguous answer.
 *
 * That was half right and stopped one step too early. The prose is not
 * scorable, but `explainsTheFailure` is — it is a boolean, and for a given
 * commit and a given incident there is a correct value. That is exactly the
 * shape of `suspectedCommitSha`'s null, and it is scorable for the same reason.
 *
 * So this set measures the two things that have answers and leaves the prose
 * alone:
 *
 *   1. did it correctly judge whether the diff explains the failure
 *   2. does the fix it proposes name a file the commit actually touched
 *
 * WHAT MAKES THE SET HARD
 * Cases are built in PAIRS from one incident: the same symptoms, attributed
 * once to the commit that really caused them and once to a commit that plainly
 * could not have. A model that reads the diff answers differently to the two.
 * A model that simply agrees with whatever it was handed answers the same to
 * both, and scores 50%.
 *
 * That pairing is the whole design. Without it, "reads the diff" and "trusts
 * the correlation" produce identical scores — the same trap the correlation set
 * avoids by having four declines for four different reasons.
 *
 * `commitFiles` IS STORED WITH THE CASE
 * So the scorer needs no repository. A case carries its packet, its label and
 * the file list its fix will be checked against, and is therefore
 * self-contained — the same property that lets correlation cases survive a
 * fixture rebuild.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DIAGNOSIS_CASES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "diagnosis-cases",
);

export const diagnosisCaseSchema = z.object({
  name: z.string().min(1),
  scenario: z.string().min(1),
  capturedAt: z.string(),
  /** The commit the packet attributes the incident to. */
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  expect: z.object({
    /**
     * Whether the diff in this packet genuinely explains the symptoms.
     *
     * The one boolean in Phase 4 with a correct answer, and the reason this set
     * can exist at all.
     */
    explainsTheFailure: z.boolean(),
    /** Why that is the right answer. Read by humans, not the scorer. */
    note: z.string(),
  }),
  /**
   * Files the attributed commit touches. A fix is checked against these — it
   * cannot sensibly propose changing a file the commit never went near.
   * Stored so scoring needs no repository.
   */
  commitFiles: z.array(z.string()).default([]),
  /** The exact user prompt the root-cause agent receives. */
  context: z.string().min(1),
});

export type DiagnosisCase = z.infer<typeof diagnosisCaseSchema>;

export function loadDiagnosisCases(filter?: string): DiagnosisCase[] {
  let files: string[];
  try {
    files = readdirSync(DIAGNOSIS_CASES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const cases = files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(DIAGNOSIS_CASES_DIR, file), "utf8"));
    const parsed = diagnosisCaseSchema.safeParse(raw);

    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`${file} is not a valid diagnosis case — ${issues}`);
    }
    return parsed.data;
  });

  const filtered = filter ? cases.filter((c) => c.name === filter) : cases;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveDiagnosisCase(golden: DiagnosisCase): string {
  const path = join(DIAGNOSIS_CASES_DIR, `${golden.name}.json`);
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  return path;
}
