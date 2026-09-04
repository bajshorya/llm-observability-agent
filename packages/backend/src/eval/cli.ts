/**
 * `pnpm eval` — the evaluation harness's command-line interface.
 *
 * WHAT THIS FILE DOES
 * Runs the golden set against a provider and prints a scorecard; also captures
 * new cases, lists the set, and shows a case's evidence.
 *
 * THE MOST USEFUL THING IT ENABLES IS A COMPARISON
 * Run it against the stub and against a model. The stub scores by counting
 * which detectors fired — it IS the statistical judgement, with no reading
 * involved — so the difference between the two runs is the value Tier 2 adds,
 * measured rather than asserted:
 *
 *     dismissed benign windows   stub 0/3      gemini-3.5-flash 3/3
 *
 * Every benign case the stub gets wrong is a case statistics alone cannot
 * solve, which is the entire argument for the expensive tier.
 *
 * THE OPTIONS
 *   --provider <name>  score a different provider without touching .env
 *   --case <name>      one case, for iterating on a single failure
 *   --list             the set and its labels
 *   --show <name>      the exact evidence packet — read this first when a
 *                      score looks wrong
 *   --capture <name>   save the newest anomaly as a golden case
 *
 * CAPTURING A CASE
 *     pnpm generate inject --scenario deploy-restart --minutes 5
 *     pnpm detect
 *     pnpm eval --capture deploy-restart --expect benign --severity low \
 *               --note "recovered within a minute"
 *
 * `--capture` defaults to the most recently detected anomaly, which removes the
 * id-copying step between commands. `scripts/capture-cases.sh` automates the
 * whole set.
 *
 * EXIT CODE
 * Non-zero when any verdict is wrong or any case failed. `pnpm eval` therefore
 * fails when the system fails — a benchmark that exits 0 while reporting 0/3
 * would be lying by omission.
 */

import { parseArgs } from "node:util";
import { renderContextForIncident } from "../correlation/correlate";
import { resolveCandidateSha } from "../correlation/grounding";
import { loadCorrelationCases, saveCorrelationCase, type CorrelationCase } from "./correlation-cases";
import { runCorrelationEval } from "./run-correlation";
import { loadPinnedVerdict } from "./verdicts";
import type { CorrelationCaseScore, CorrelationSummary } from "./score-correlation";
import { severities, type Severity } from "@obs/shared";
import { renderContextForAnomaly } from "../classification/classify";
import { env, llmProviderNames, type LlmProviderName } from "../env";
import { createProvider } from "../llm";
import { loadCases, saveCase, type GoldenCase } from "./cases";
import { runEval } from "./run";
import type { CaseScore, EvalSummary } from "./score";

const USAGE = `
Golden-set evaluation for the Tier 2 classifier.

Usage:
  pnpm eval [options]

Options:
  --provider <name>   ${llmProviderNames.join(" | ")}  (default: ${env.LLM_PROVIDER})
  --case <name>       Run a single case
  --list              List the golden set and exit
  --show <name>       Print a case's evidence packet and exit
  --capture <name>    Save the newest anomaly as a golden case (see below)
  --correlation       Operate on the Phase 3 correlation set instead
  -h, --help          Show this message

Correlation mode (--correlation) takes the same --provider, --case, --list and
--show, and captures with --sha <sha|none> --files a,b --note "...":

  pnpm eval --correlation
  pnpm eval --correlation --provider stub      # blame-the-newest baseline
  pnpm eval --correlation --capture new-error --sha 0c701a0 \\
            --files src/lib/pricing.js --note "the null-price bug"

  --diff selects the experimental with-hunks arm: on capture it stores that
  packet from the same incident, and on a run it scores that arm instead of the
  default one. The two are never blended. See DOCUMENTATION-EVALS.md §14.


Capturing a case:
  pnpm generate inject --scenario deploy-restart --minutes 5
  pnpm detect
  pnpm eval --capture deploy-restart --scenario deploy-restart \\
            --expect benign --severity low --note "recovered within a minute"

  --expect <v>        incident | benign
  --severity <s>      ${severities.join(" | ")}
  --scenario <s>      Generator scenario the case came from
  --note "<text>"     Why this is the right answer
`.trim();

const tick = (ok: boolean): string => (ok ? "PASS" : "FAIL");

function reportCase(score: CaseScore): void {
  const kind = score.benignCase ? "benign  " : "incident";
  const verdict = score.actual.isRealIncident ? "incident" : "dismissed";

  console.log(
    `  ${tick(score.verdictCorrect)} ${score.name.padEnd(17)} ${kind} -> ` +
      `${verdict} / ${score.actual.severity} (expected ${score.expected.severity})`,
  );

  if (!score.verdictCorrect) {
    console.log(`       verdict wrong: ${score.expected.note}`);
  }
  if (!score.severityWithinOne) {
    console.log(`       severity more than one band off`);
  }
  if (!score.grounding.grounded) {
    console.log(`       ungrounded area "${score.actual.affectedArea}" — ${score.grounding.reason}`);
  }
}

function reportSummary(summary: EvalSummary): void {
  const pct = (n: number, total: number): string =>
    total === 0 ? "n/a" : `${Math.round((n / total) * 100)}%`;

  console.log("\nScorecard:");
  console.log(
    `  dismissed benign windows   ${summary.dismissals.correct}/${summary.dismissals.total}` +
      `  (${pct(summary.dismissals.correct, summary.dismissals.total)})`,
  );
  console.log(
    `  confirmed real incidents   ${summary.incidents.correct}/${summary.incidents.total}` +
      `  (${pct(summary.incidents.correct, summary.incidents.total)})`,
  );
  console.log(
    `  severity within one band   ${summary.severityWithinOne}/${summary.total}` +
      `  (exact ${summary.severityExact}/${summary.total})`,
  );
  console.log(
    `  area grounded in evidence  ${summary.grounded}/${summary.total}` +
      `  (${pct(summary.grounded, summary.total)})`,
  );

  const tokens =
    summary.totalInputTokens === 0 && summary.totalOutputTokens === 0
      ? "tokens not reported"
      : `${summary.totalInputTokens} in / ${summary.totalOutputTokens} out`;
  console.log(
    `  cost                       ${tokens}, ${summary.totalRepairs} repair(s), ` +
      `mean ${summary.meanLatencyMs}ms`,
  );

  if (summary.failures > 0) {
    console.log(`  ${summary.failures} case(s) produced no valid answer at all`);
  }
}

function parseSeverity(value: string | undefined): Severity {
  if (value && (severities as readonly string[]).includes(value)) return value as Severity;
  throw new Error(
    `--severity is required when capturing. Expected one of: ${severities.join(", ")}`,
  );
}

/**
 * Capture a correlation case.
 *
 * `--sha` is resolved against the very candidates this case will contain, and
 * throws when it matches none. A case whose expected sha is absent from its own
 * packet is unsatisfiable — it would score every model wrong forever, and look
 * like a model failure rather than a labelling one.
 */
async function captureCorrelation(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const name = values["capture"] as string;
  const sha = values["sha"] as string | undefined;

  if (sha === undefined) {
    throw new Error(`--sha is required: a full or abbreviated sha, or "none" for a decline case`);
  }

  /**
   * `--diff` captures the experimental packet, with hunks, from the SAME
   * incident as the default one. That is what makes the A/B controlled:
   * capturing the arms from separate runs would confound the hunks with
   * whatever else differed — different traffic, different fixture shas, and
   * (as it turned out to matter most) a different classifier summary.
   */
  /**
   * The classifier's verdict is PINNED rather than read from the row. That is
   * what makes a re-capture comparable to the capture before it: without it,
   * half the packet is a fresh model answer and the set's difficulty drifts.
   * See `verdicts.ts`.
   */
  const scenario = (values["scenario"] as string | undefined) ?? name;
  const verdict = loadPinnedVerdict(scenario);

  const rendered = await renderContextForIncident(
    undefined,
    {
      verdict: {
        severity: verdict.severity,
        summary: verdict.summary,
        affectedArea: verdict.affectedArea,
      },
    },
    { diffs: values["diff"] === true },
  );
  if (!rendered) {
    throw new Error(
      "No anomalies in the database. Inject a scenario and run `pnpm detect` first.",
    );
  }

  let expected: string | null = null;
  if (sha !== "none") {
    expected = resolveCandidateSha(sha, rendered.commits);
    if (expected === null) {
      throw new Error(
        `--sha "${sha}" matches none of the ${rendered.commits.length} candidate(s) in this packet. ` +
          `A case cannot expect a commit its own evidence does not contain.`,
      );
    }
  }

  const files = (values["files"] as string | undefined)
    ?.split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (expected === null && files && files.length > 0) {
    throw new Error("--files cannot be set on a decline case: there is no commit to own them");
  }

  const golden: CorrelationCase = {
    name,
    scenario,
    capturedAt: new Date().toISOString(),
    expect: {
      suspectedCommitSha: expected,
      implicatedFiles: files ?? [],
      note: (values["note"] as string | undefined) ?? "",
    },
    context: rendered.context,
  };

  const path = saveCorrelationCase(golden);
  console.log(`Captured correlation case "${name}" from anomaly ${rendered.anomalyId.slice(0, 8)}`);
  console.log(`  verdict: pinned from ${scenario}.json (${verdict.severity}, ${verdict.affectedArea})`);
  console.log(
    `  expect: ${expected ? expected.slice(0, 10) : "no commit"} from ${rendered.commits.length} candidate(s)`,
  );
  console.log(`  ${golden.context.split("\n").length} lines of evidence -> ${path}`);
}

function reportCorrelationCase(score: CorrelationCaseScore): void {
  const mark = score.attributionCorrect ? "ok  " : "WRONG";
  const answer = score.actual.suspectedCommitSha
    ? score.actual.suspectedCommitSha.slice(0, 10)
    : "no commit";
  const want = score.expected.suspectedCommitSha
    ? score.expected.suspectedCommitSha.slice(0, 10)
    : "no commit";

  console.log(
    `  ${mark} ${score.name.padEnd(18)} said ${answer.padEnd(11)} want ${want.padEnd(11)} ` +
      `conf ${score.actual.confidence.toFixed(2)}`,
  );

  if (score.filesCorrect === false) {
    console.log(`       missed file(s): ${score.missingFiles.join(", ")}`);
  }

  /**
   * The reasoning is printed for wrong answers only, and it is the first thing
   * to read when a score looks wrong — because the answer is as often a bad
   * LABEL as a bad model. Two of the six classifier labels turned out to be
   * mine to fix, and both were found this way.
   */
  if (!score.attributionCorrect) {
    console.log(`       why: ${score.actual.reasoning}`);
    console.log(`       label: ${score.expected.note}`);
  }
}

function reportCorrelationSummary(summary: CorrelationSummary): void {
  const pct = (correct: number, total: number): string =>
    total === 0 ? "  n/a" : `${Math.round((correct / total) * 100)}%`.padStart(5);

  const conf = (value: number | null): string => (value === null ? "n/a" : value.toFixed(2));

  console.log("");
  console.log("Scorecard:");
  console.log(
    `  named the right commit    ${summary.attributions.correct}/${summary.attributions.total}  ` +
      `${pct(summary.attributions.correct, summary.attributions.total)}`,
  );
  console.log(
    `  declined when it should   ${summary.declines.correct}/${summary.declines.total}  ` +
      `${pct(summary.declines.correct, summary.declines.total)}`,
  );
  console.log(
    `  right files within it     ${summary.files.correct}/${summary.files.total}  ` +
      `${pct(summary.files.correct, summary.files.total)}`,
  );
  console.log(
    `  confidence when right     ${conf(summary.confidence.whenCorrect)}   ` +
      `when wrong ${conf(summary.confidence.whenWrong)}`,
  );

  if (summary.failures > 0) {
    console.log(`  no valid answer           ${summary.failures}`);
  }

  console.log(
    `  cost                      ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out, ` +
      `${summary.totalRepairs} repair(s), mean ${summary.meanLatencyMs}ms`,
  );
  console.log("");
  console.log(
    "The two accuracy rows are never averaged. A model that names the newest commit",
  );
  console.log(
    "every time scores 100% on the first and 0% on the second; one that always",
  );
  console.log("declines scores the reverse. Blended, both read as 'about half'.");
}

async function runCorrelationMode(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const arm = values["diff"] === true ? "diff" : "default";

  if (values["list"]) {
    const cases = loadCorrelationCases(undefined, arm);
    console.log(`${cases.length} correlation case(s):`);
    for (const golden of cases) {
      const want = golden.expect.suspectedCommitSha
        ? golden.expect.suspectedCommitSha.slice(0, 10)
        : "no commit ";
      console.log(`  ${golden.name.padEnd(18)} ${want}  ${golden.expect.note}`);
    }
    return;
  }

  if (typeof values["show"] === "string") {
    const [golden] = loadCorrelationCases(values["show"], arm);
    console.log(golden ? golden.context : `No correlation case named "${values["show"]}"`);
    return;
  }

  const cases = loadCorrelationCases(values["case"] as string | undefined, arm);
  if (cases.length === 0) {
    console.log(
      "The correlation golden set is empty. Capture one with:\n" +
        "  pnpm eval --correlation --capture <name> --sha <sha|none> --note '...'",
    );
    return;
  }

  const providerName = values["provider"] as LlmProviderName | undefined;
  if (providerName && !llmProviderNames.includes(providerName)) {
    throw new Error(`Unknown provider "${providerName}".`);
  }

  const provider = providerName ? createProvider(providerName) : createProvider();
  console.log(
    `Evaluating ${cases.length} correlation case(s) against ${provider.name} (${provider.model}):\n`,
  );

  const run = await runCorrelationEval(provider, cases, reportCorrelationCase);

  for (const failure of run.failures) {
    console.log(`  FAIL ${failure.name.padEnd(18)} no valid answer — ${failure.error}`);
  }

  reportCorrelationSummary(run.summary);

  const wrong =
    run.summary.attributions.total -
    run.summary.attributions.correct +
    (run.summary.declines.total - run.summary.declines.correct);

  if (wrong > 0 || run.failures.length > 0) process.exitCode = 1;
}

async function capture(values: Record<string, string | boolean | undefined>): Promise<void> {
  const name = values["capture"] as string;
  const expect = values["expect"];

  if (expect !== "incident" && expect !== "benign") {
    throw new Error(`--expect must be "incident" or "benign"`);
  }

  const rendered = await renderContextForAnomaly();
  if (!rendered) {
    throw new Error("No anomalies in the database. Inject a scenario and run `pnpm detect` first.");
  }

  const golden: GoldenCase = {
    name,
    scenario: (values["scenario"] as string | undefined) ?? name,
    capturedAt: new Date().toISOString(),
    expect: {
      isRealIncident: expect === "incident",
      severity: parseSeverity(values["severity"] as string | undefined),
      note: (values["note"] as string | undefined) ?? "",
    },
    context: rendered.context,
  };

  const path = saveCase(golden);
  console.log(`Captured "${name}" from anomaly ${rendered.anomalyId.slice(0, 8)}`);
  console.log(`  expect: ${expect}, severity ${golden.expect.severity}`);
  console.log(`  ${golden.context.split("\n").length} lines of evidence -> ${path}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      case: { type: "string" },
      list: { type: "boolean" },
      show: { type: "string" },
      capture: { type: "string" },
      expect: { type: "string" },
      severity: { type: "string" },
      scenario: { type: "string" },
      note: { type: "string" },
      correlation: { type: "boolean" },
      sha: { type: "string" },
      files: { type: "string" },
      diff: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  // `--correlation` switches the whole command to the Phase 3 set: list, show,
  // capture and run all operate on correlation cases instead.
  if (values.correlation) {
    if (values.capture) {
      await captureCorrelation(values);
      return;
    }
    await runCorrelationMode(values);
    return;
  }

  if (values.capture) {
    await capture(values);
    return;
  }

  if (values.list) {
    const cases = loadCases();
    console.log(`${cases.length} golden case(s):`);
    for (const golden of cases) {
      const kind = golden.expect.isRealIncident ? "incident" : "benign  ";
      console.log(`  ${golden.name.padEnd(17)} ${kind} ${golden.expect.severity.padEnd(8)} ${golden.expect.note}`);
    }
    return;
  }

  if (values.show) {
    const [golden] = loadCases(values.show);
    console.log(golden ? golden.context : `No case named "${values.show}"`);
    return;
  }

  const cases = loadCases(values.case);
  if (cases.length === 0) {
    console.log(
      values.case
        ? `No case named "${values.case}". Run --list to see the set.`
        : "The golden set is empty. Capture a case with --capture.",
    );
    return;
  }

  const providerName = values.provider as LlmProviderName | undefined;
  if (providerName && !llmProviderNames.includes(providerName)) {
    throw new Error(`Unknown provider "${providerName}".`);
  }

  const provider = providerName ? createProvider(providerName) : createProvider();
  console.log(`Evaluating ${cases.length} case(s) against ${provider.name} (${provider.model}):\n`);

  const run = await runEval(provider, cases, reportCase);

  for (const failure of run.failures) {
    console.log(`  FAIL ${failure.name.padEnd(17)} no valid answer — ${failure.error}`);
  }

  reportSummary(run.summary);

  // A wrong verdict is the failure this harness exists to catch.
  if (run.summary.verdictCorrect < run.summary.total || run.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
