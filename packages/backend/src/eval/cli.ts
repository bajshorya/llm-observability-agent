import { parseArgs } from "node:util";
import { severities, type Severity } from "@obs/shared";
import { renderContextForAnomaly } from "../classification/classify";
import { env, llmProviderNames, type LlmProviderName } from "../env";
import { createProvider } from "../llm";
import { loadCases, saveCase, type GoldenCase } from "./cases";
import { runEval } from "./run";
import type { CaseScore, EvalSummary } from "./score";

/**
 * The eval harness.
 *
 * Its most useful output is the comparison it makes possible: run it against
 * the stub and against a model, and the difference is the value Tier 2 adds,
 * measured rather than asserted. The stub scores by counting which detectors
 * fired — which is precisely the statistical judgement — so every benign case
 * it gets wrong is a case statistics alone cannot solve.
 */

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
  -h, --help          Show this message

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
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
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
