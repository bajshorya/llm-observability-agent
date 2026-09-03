/**
 * Pinned Tier 2 verdicts — what a correlation case holds fixed.
 *
 * WHAT THIS FILE DOES
 * Loads a canonical classification per scenario: severity, summary and
 * affected area, stored as a fixture. Capture uses it instead of calling Tier 2
 * again.
 *
 * THE DEFECT THIS FIXES
 * A correlation packet embeds the classifier's verdict, and the classifier is
 * a model answering freshly generated traffic. So re-capturing the correlation
 * set silently changed how hard it was:
 *
 *   August    area: /orders endpoints
 *             "latency degradation affecting the refund and order creation paths"
 *   September area: payments-service dependency
 *             "a latency spike driven by upstream timeouts contacting payments-service"
 *
 * Same scenario, same label, materially different task. When Tier 2 names an
 * external cause, declining is nearly free; when it points at the order
 * endpoints, the correlator is invited to blame a commit that touches them.
 * A case failed on three models in one capture and passed on two in the next,
 * with no change to the packet at all.
 *
 * Correlation is the first stage whose golden cases inherit another model's
 * JUDGEMENT rather than its inputs, and inheriting judgement means inheriting
 * variance. `DOCUMENTATION-EVALS.md` §14.
 *
 * WHY PINNING IS THE RIGHT FIX AND NOT A CHEAT
 * An eval measures one stage with its input held fixed. The classifier set does
 * this already — a case stores the rendered prompt, so the same evidence is
 * scored every time. The correlation set was not doing it: half its input was
 * being re-derived by a model at capture time.
 *
 * Pinning restores the property. The verdict here is a real one, produced by a
 * real Tier 2 run and recorded, exactly as the stored context is a real packet
 * produced by a real pipeline run. What changes is that it stops being redrawn.
 *
 * A SIDE EFFECT WORTH HAVING
 * Capture no longer calls a model at all. It cost one classification per case
 * on a free tier where quota is the binding constraint, and those calls were
 * the source of the variance they were paying for.
 *
 * WHEN TO RE-PIN
 * When a scenario's evidence changes enough that its stored verdict is no
 * longer what Tier 2 would say — a rewritten scenario, a changed classifier
 * prompt. Re-pin deliberately, from a real run, and expect scores to move:
 * that is a new capture generation, and numbers do not cross between them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { severitySchema } from "@obs/shared";

export const VERDICTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "verdicts");

export const pinnedVerdictSchema = z.object({
  scenario: z.string().min(1),
  severity: severitySchema,
  summary: z.string().min(10),
  affectedArea: z.string().min(1),
  /** Why this is the right verdict for this scenario. Read by humans. */
  note: z.string(),
  /** When the real Tier 2 run that produced it was captured. */
  capturedFrom: z.string(),
  /**
   * Which model produced it. Recorded because the pins are not all from one
   * model — free-tier quota is per model and per day, so a scenario added when
   * the default was exhausted was pinned from another. Re-pinning the whole set
   * from one model is worth doing and has not been done.
   */
  model: z.string().min(1),
});

export type PinnedVerdict = z.infer<typeof pinnedVerdictSchema>;

/**
 * Load one scenario's pinned verdict.
 *
 * Throws rather than falling back to a live classification. A silent fallback
 * would reintroduce exactly the variance this exists to remove, and would do it
 * invisibly — the capture would succeed and only the scores would drift.
 */
export function loadPinnedVerdict(scenario: string): PinnedVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(VERDICTS_DIR, `${scenario}.json`), "utf8"));
  } catch {
    const known = listPinnedVerdicts().join(", ") || "none";
    throw new Error(
      `No pinned verdict for scenario "${scenario}". Known: ${known}.\n` +
        `Add ${scenario}.json to src/eval/verdicts/ with a real Tier 2 verdict.`,
    );
  }

  const parsed = pinnedVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`${scenario}.json is not a valid pinned verdict — ${issues}`);
  }

  return parsed.data;
}

export function listPinnedVerdicts(): string[] {
  try {
    return readdirSync(VERDICTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}
