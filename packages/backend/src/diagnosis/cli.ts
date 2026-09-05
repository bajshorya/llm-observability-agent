/**
 * `pnpm diagnose` — the Phase 4 operator interface.
 *
 * WHAT THIS FILE DOES
 * Parses arguments, drives `diagnose.ts`, formats the results. Presentation
 * only; every decision lives in the module it calls.
 *
 * THE FOURTH COMMAND, FOR THE THIRD TIME
 * detect → classify → correlate → diagnose. Each stage that spends quota is an
 * explicit act, which is why none of them chain by default.
 *
 * IT ONLY RUNS ON ATTRIBUTED INCIDENTS
 * A correlation that declined has no commit and therefore no diff. That is a
 * scoping decision rather than a gap, and `--stats` shows the shortfall
 * directly: attributed versus diagnosed.
 *
 * WHAT THE OUTPUT LEADS WITH
 * Whether the model thought the diff explained the failure at all. A hypothesis
 * that disagrees with the correlation it was handed is the most interesting
 * output this stage can produce, and burying it under a paragraph of root cause
 * would waste it.
 *
 * NOTHING IS APPLIED
 * There is no `--apply`. `hypotheses.applied` defaults to false and no code in
 * this repository writes it. The agent diagnoses; a human decides.
 */

import { parseArgs } from "node:util";
import { env, llmProviderNames, type LlmProviderName } from "../env";
import { createProvider } from "../llm";
import { llmConfig } from "../llm/config";
import {
  diagnoseAnomalies,
  diagnosisFunnel,
  previewDiagnosisPrompt,
  type DiagnosisOutcome,
} from "./diagnose";

const USAGE = `
Phase 4 root cause — why the commit broke it, and what to change.

Usage:
  pnpm diagnose [options]

Options:
  --limit <n>        Maximum incidents per run (default 10)
  --anomaly <id>     Diagnose one incident, even if already diagnosed
  --provider <name>  Override LLM_PROVIDER: ${llmProviderNames.join(" | ")}
  --preview          Print the exact prompt and exit (no call). Uses the most
                     recent attributed incident, or --anomaly to pick one
  --repo <path>      Override TARGET_REPO_PATH for this run
  --stats            Print the diagnosis funnel, then exit
  -h, --help         Show this message

Only incidents whose correlation NAMED a commit are diagnosed — a declined
correlation has no diff to reason from.

Nothing is ever applied. Every hypothesis is a proposal for a human to review.

Current provider: ${env.LLM_PROVIDER} (temperature ${llmConfig.temperature}, up to ${llmConfig.maxRepairAttempts} repair attempts)
Target repository: ${env.TARGET_REPO_PATH}
`.trim();

function reportOutcome(outcome: DiagnosisOutcome): void {
  const short = outcome.anomalyId.slice(0, 8);

  if (outcome.status === "failed") {
    console.log(`  ${short} ${outcome.service}: FAILED — ${outcome.error}`);
    return;
  }

  const { hypothesis, stats, sha } = outcome;
  if (!hypothesis) return;

  // Leads with the disagreement, because that is the finding worth seeing.
  const verdict = hypothesis.explainsTheFailure
    ? `explains ${sha?.slice(0, 10)}`
    : `DOES NOT explain ${sha?.slice(0, 10)}`;

  console.log(`  ${short} ${outcome.service}: ${verdict} (confidence ${hypothesis.confidence.toFixed(2)})`);
  console.log(`    cause: ${hypothesis.rootCause}`);
  console.log(`    fix:   ${hypothesis.suggestedFix}`);

  if (stats) {
    const tokens =
      stats.inputTokens === null && stats.outputTokens === null
        ? "tokens n/a"
        : `${stats.inputTokens ?? "?"} in / ${stats.outputTokens ?? "?"} out`;
    console.log(`    ${tokens}, ${stats.latencyMs}ms, ${stats.repairAttempts} repair(s)`);
  }
}

async function printStats(): Promise<void> {
  const funnel = await diagnosisFunnel();

  console.log("Diagnosis funnel:");
  console.log(
    `  ${funnel.attributed} attributed incident(s) -> ${funnel.diagnosed} diagnosed ` +
      `(${funnel.explained} explained by the diff, ${funnel.unexplained} not)`,
  );
  console.log(`  ${funnel.applied} applied — and this number is expected to stay zero.`);

  if (funnel.diagnosed === 0) {
    console.log("\nNothing diagnosed yet. Run `pnpm diagnose`.");
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      anomaly: { type: "string" },
      provider: { type: "string" },
      preview: { type: "boolean" },
      repo: { type: "string" },
      stats: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.stats) {
    await printStats();
    return;
  }

  const shared = values.repo !== undefined ? { repoPath: values.repo } : {};

  if (values.preview) {
    const prompt = await previewDiagnosisPrompt(values.anomaly, shared);
    console.log(
      prompt ??
        "No attributed incident found. Run `pnpm detect`, `pnpm classify` and `pnpm correlate` first.",
    );
    return;
  }

  const providerName = values.provider as LlmProviderName | undefined;
  if (providerName && !llmProviderNames.includes(providerName)) {
    throw new Error(
      `Unknown provider "${providerName}". Expected one of: ${llmProviderNames.join(", ")}`,
    );
  }

  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }

  const provider = providerName ? createProvider(providerName) : createProvider();
  const result = await diagnoseAnomalies({ provider, limit, anomalyId: values.anomaly, ...shared });

  console.log(`Provider: ${result.provider} (${result.model})`);

  if (result.outcomes.length === 0) {
    console.log("  nothing to diagnose — every attributed incident already has a hypothesis");
    return;
  }

  for (const outcome of result.outcomes) reportOutcome(outcome);

  const failed = result.outcomes.filter((o) => o.status === "failed").length;
  if (failed > 0) {
    console.log(`\n${failed} of ${result.outcomes.length} failed; they stay undiagnosed.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
