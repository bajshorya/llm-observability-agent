/**
 * The golden set — loading, validating and saving labelled evaluation cases.
 *
 * WHAT THIS FILE DOES
 * Defines the schema for a golden case, loads them from `cases/*.json`, and
 * writes new ones during capture. Six cases exist: three real incidents, three
 * benign windows that trip Tier 1 anyway.
 *
 * WHAT A CASE CONTAINS
 *   name, scenario, capturedAt   provenance
 *   expect.isRealIncident        the verdict a competent on-call would give
 *   expect.severity              scored within one band
 *   expect.note                  WHY that is the right answer, for humans
 *   context                      the entire rendered prompt, as a string
 *
 * WHY `context` IS A STORED STRING AND NOT A STRUCTURE
 * This is the central design decision of the harness. The alternative — storing
 * a structured input and re-rendering it at eval time — measures the wrong
 * thing: if the renderer changes, every fixture changes silently with it, and
 * the eval keeps reporting on whatever the renderer does today.
 *
 * A stored string is a FIXED ARTEFACT. It is exactly what some real pipeline run
 * produced, so scores are comparable across prompt and packet versions.
 *
 * The cost is real and accepted: when the evidence packet changes, every case
 * must be re-captured. `scripts/capture-cases.sh` exists for precisely that,
 * and it has been needed three times.
 *
 * WHY CASES ARE VALIDATED ON LOAD RATHER THAN TRUSTED
 * A case missing `isRealIncident` would score as `undefined !== true` — a
 * silent wrong answer recorded against the model. That is the worst failure
 * mode a benchmark can have, so a malformed file throws with the field named.
 *
 * WHY THE LABELS ARE HALF BENIGN
 * A set of only real incidents cannot distinguish a competent classifier from
 * one that answers "critical incident" to everything. The benign half is what
 * makes the score meaningful — and it is the half that found two of the labels
 * were originally wrong.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { severitySchema } from "@obs/shared";

export const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), "cases");

export const goldenCaseSchema = z.object({
  name: z.string().min(1),
  /** The generator scenario this was captured from. */
  scenario: z.string().min(1),
  capturedAt: z.string(),
  expect: z.object({
    isRealIncident: z.boolean(),
    /** Scored within one band — the boundary between high and critical is a judgement call. */
    severity: severitySchema,
    /** Why this is the right answer. Read by humans, not by the scorer. */
    note: z.string(),
  }),
  /** The exact user prompt the classifier receives. */
  context: z.string().min(1),
});

export type GoldenCase = z.infer<typeof goldenCaseSchema>;

export function loadCases(filter?: string): GoldenCase[] {
  let files: string[];
  try {
    files = readdirSync(CASES_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  const cases = files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
    const parsed = goldenCaseSchema.safeParse(raw);
    if (!parsed.success) {
      // A malformed case would silently skew the score. Fail loudly instead.
      throw new Error(
        `Golden case ${file} is invalid:\n${parsed.error.issues
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
          .join("\n")}`,
      );
    }
    return parsed.data;
  });

  const selected = filter ? cases.filter((c) => c.name === filter) : cases;
  return selected.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveCase(golden: GoldenCase): string {
  const path = join(CASES_DIR, `${golden.name}.json`);
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  return path;
}
