import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { severitySchema } from "@obs/shared";

/**
 * The golden set.
 *
 * Each case is a real prompt captured from a real pipeline run, paired with the
 * verdict a competent on-call engineer would give it. Captured rather than
 * handwritten on purpose: a fixture composed by hand drifts from what the
 * system actually sends, and then the eval measures a prompt nobody uses.
 *
 * Half the set is benign. That half is the point — every one of those windows
 * tripped Tier 1, and a classifier that cannot dismiss them is a classifier
 * that adds nothing to the statistics it sits behind.
 */

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
