import { parseArgs } from "node:util";
import { env, llmProviderNames, type LlmProviderName } from "../env";
import { createProvider } from "../llm";
import { llmUsageSummary } from "../llm/calls";
import { llmConfig } from "../llm/config";
import {
  classificationFunnel,
  classifyAnomalies,
  previewPrompt,
  type ClassificationOutcome,
} from "./classify";

/**
 * Tier 2 CLI. Separate command from `detect` by default, because the two tiers
 * have genuinely different operational characters: detection is free and can
 * run every thirty seconds, classification costs quota and should not.
 */

const USAGE = `
Tier 2 classification — LLM judgement over Tier 1 anomalies.

Usage:
  pnpm classify [options]

Options:
  --limit <n>        Maximum anomalies per run (default 10)
  --anomaly <id>     Classify one anomaly, even if already classified
  --provider <name>  Override LLM_PROVIDER: ${llmProviderNames.join(" | ")}
  --preview <id>     Print the exact prompt for an anomaly and exit (no call)
  --stats            Print LLM usage and the detection funnel, then exit
  -h, --help         Show this message

Current provider: ${env.LLM_PROVIDER} (temperature ${llmConfig.temperature}, up to ${llmConfig.maxRepairAttempts} repair attempts)
The default provider is the deterministic stub — no API key, no network, no cost.
`.trim();

function reportOutcome(outcome: ClassificationOutcome): void {
  const short = outcome.anomalyId.slice(0, 8);

  if (outcome.status === "failed") {
    console.log(`  ${short} ${outcome.service}: FAILED — ${outcome.error}`);
    return;
  }

  const { classification: result, stats } = outcome;
  if (!result) return;

  const verdict = result.isRealIncident ? "incident" : "dismissed";
  console.log(
    `  ${short} ${outcome.service}: ${result.severity.toUpperCase()} (${verdict})`,
  );
  console.log(`    ${result.summary}`);
  console.log(`    area: ${result.affectedArea}`);

  if (stats) {
    const tokens =
      stats.inputTokens === null && stats.outputTokens === null
        ? "tokens n/a"
        : `${stats.inputTokens ?? "?"} in / ${stats.outputTokens ?? "?"} out`;
    console.log(
      `    ${tokens}, ${stats.latencyMs}ms, ${stats.repairAttempts} repair(s)`,
    );
  }
}

async function printStats(): Promise<void> {
  const funnel = await classificationFunnel();
  const usage = await llmUsageSummary();

  console.log("Detection funnel:");
  console.log(
    `  ${funnel.anomalies} anomalies -> ${funnel.classified} classified ` +
      `(${funnel.realIncidents} real, ${funnel.dismissed} dismissed)`,
  );

  if (usage.length === 0) {
    console.log("\nNo LLM calls recorded yet.");
    return;
  }

  console.log("\nLLM usage:");
  for (const row of usage) {
    const tokens =
      row.inputTokens === null && row.outputTokens === null
        ? "tokens not reported"
        : `${row.inputTokens ?? 0} in / ${row.outputTokens ?? 0} out`;
    console.log(`  ${row.agent} via ${row.provider} (${row.model})`);
    console.log(
      `    ${row.calls} call(s), ${row.failed} failed, ${row.repairAttempts} repair(s), ` +
        `${tokens}, avg ${Math.round(row.avgLatencyMs)}ms`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      anomaly: { type: "string" },
      provider: { type: "string" },
      preview: { type: "string" },
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

  if (values.preview) {
    const prompt = await previewPrompt(values.preview);
    console.log(prompt ?? `No anomaly found with id ${values.preview}`);
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
  const result = await classifyAnomalies({ provider, limit, anomalyId: values.anomaly });

  console.log(`Provider: ${result.provider} (${result.model})`);

  if (result.outcomes.length === 0) {
    console.log("  nothing to classify — every anomaly already has a verdict");
    return;
  }

  for (const outcome of result.outcomes) reportOutcome(outcome);

  const failed = result.outcomes.filter((o) => o.status === "failed").length;
  if (failed > 0) {
    console.log(`\n${failed} of ${result.outcomes.length} failed; they stay unclassified.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
