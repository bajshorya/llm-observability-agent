/**
 * `pnpm correlate` — the Phase 3 operator interface.
 *
 * WHAT THIS FILE DOES
 * Parses arguments, drives `correlate.ts`, and formats the results.
 * Presentation only; every decision lives in the module it calls.
 *
 * WHY IT IS A THIRD COMMAND
 * The same argument that split classification from detection, one tier along.
 * Every stage that spends quota is an explicit act rather than a side effect of
 * the stage before it.
 *
 * THE OPTIONS, AND WHAT EACH IS FOR
 *   --limit <n>        cap per run (default 10), so a backlog cannot drain a
 *                      day's free-tier quota in one go
 *   --anomaly <id>     correlate one incident, even if already correlated
 *   --provider <name>  override LLM_PROVIDER for this run
 *   --preview          print the exact prompt and CALL NOTHING
 *   --lookback <h>     widen or narrow the commit window for this run
 *   --repo <path>      override TARGET_REPO_PATH for this run
 *   --stats            the correlation funnel, then exit
 *
 * `--preview` TAKES NO ID; `--anomaly` PICKS ONE
 * Unlike `pnpm classify --preview <id>`, the target is implicit: the most
 * recent real incident, or whatever `--anomaly` already selects. Correlation
 * runs on a much smaller set than classification — only incidents that survived
 * Tier 2 — so "the latest one" is almost always the one being looked at, and
 * copying an id between commands is friction with no purpose.
 *
 * It is a boolean rather than an optional-value flag because `parseArgs` has no
 * optional values: a string option always consumes the next argument, so
 * `--preview` alone would fail rather than defaulting.
 *
 * WHY `--repo` EXISTS
 * Pointing a run at a different checkout without editing `.env` is what makes
 * "does this work against a real repository?" a one-line experiment rather than
 * a configuration change. It is also how the fixture and a real repo can be
 * compared back to back.
 *
 * WHAT THE OUTPUT REPORTS THAT IS NOT OBVIOUS
 * The candidate count is printed on every line. A correlation that declined
 * from twelve candidates and one that declined from zero are completely
 * different findings, and without the count they read identically.
 *
 * Dropped files are printed as a warning rather than hidden. `grounding.ts`
 * removes paths the named commit does not contain; a model inventing paths is
 * a signal about that model, and swallowing it would waste the observation.
 *
 * EXIT CODE
 * Non-zero when any incident failed, so a scheduled run surfaces quota
 * exhaustion or a missing target repository rather than silently doing nothing.
 */

import { parseArgs } from "node:util";
import { env, llmProviderNames, type LlmProviderName } from "../env";
import { createProvider } from "../llm";
import { llmConfig } from "../llm/config";
import {
  correlateAnomalies,
  correlationFunnel,
  previewCorrelationPrompt,
  type CorrelationOutcome,
} from "./correlate";
import { defaultLookback } from "./git";

const USAGE = `
Phase 3 correlation — which commit explains this incident, if any.

Usage:
  pnpm correlate [options]

Options:
  --limit <n>        Maximum incidents per run (default 10)
  --anomaly <id>     Correlate one incident, even if already correlated
  --provider <name>  Override LLM_PROVIDER: ${llmProviderNames.join(" | ")}
  --preview          Print the exact prompt and exit (no call). Uses the most
                     recent real incident, or --anomaly to pick one
  --lookback <h>     Hours of commit history to consider (default ${defaultLookback.hours})
  --repo <path>      Override TARGET_REPO_PATH for this run
  --stats            Print the correlation funnel, then exit
  -h, --help         Show this message

Only real incidents are correlated. Windows Tier 2 dismissed are never sent —
looking for the commit that caused a rolling restart is the call this design
exists to avoid.

Current provider: ${env.LLM_PROVIDER} (temperature ${llmConfig.temperature}, up to ${llmConfig.maxRepairAttempts} repair attempts)
Target repository: ${env.TARGET_REPO_PATH}
`.trim();

function reportOutcome(outcome: CorrelationOutcome): void {
  const short = outcome.anomalyId.slice(0, 8);
  // Printed on every line: declining from twelve candidates and declining from
  // zero are different findings that otherwise read identically.
  const scope =
    outcome.candidateCount === undefined ? "" : ` [${outcome.candidateCount} candidate(s)]`;

  if (outcome.status === "failed") {
    console.log(`  ${short} ${outcome.service}${scope}: FAILED — ${outcome.error}`);
    return;
  }

  const { correlation, grounded, stats } = outcome;
  if (!correlation || !grounded) return;

  const confidence = correlation.confidence.toFixed(2);

  if (grounded.sha === null) {
    console.log(`  ${short} ${outcome.service}${scope}: NO COMMIT (confidence ${confidence})`);
  } else {
    console.log(
      `  ${short} ${outcome.service}${scope}: ${grounded.sha.slice(0, 10)} (confidence ${confidence})`,
    );
  }

  console.log(`    ${correlation.reasoning}`);

  if (grounded.implicatedFiles.length > 0) {
    console.log(`    files: ${grounded.implicatedFiles.join(", ")}`);
  }

  // Surfaced, not swallowed — a model naming paths that are not in the commit
  // is worth seeing even though it does not invalidate the sha.
  if (grounded.droppedFiles.length > 0) {
    console.log(
      `    ! dropped ${grounded.droppedFiles.length} file(s) not in that commit: ` +
        grounded.droppedFiles.join(", "),
    );
  }

  if (stats) {
    const tokens =
      stats.inputTokens === null && stats.outputTokens === null
        ? "tokens n/a"
        : `${stats.inputTokens ?? "?"} in / ${stats.outputTokens ?? "?"} out`;
    console.log(`    ${tokens}, ${stats.latencyMs}ms, ${stats.repairAttempts} repair(s)`);
  }
}

async function printStats(): Promise<void> {
  const funnel = await correlationFunnel();

  console.log("Correlation funnel:");
  console.log(
    `  ${funnel.realIncidents} real incident(s) -> ${funnel.correlated} correlated ` +
      `(${funnel.attributed} attributed, ${funnel.declined} declined)`,
  );

  if (funnel.correlated === 0) {
    console.log("\nNothing correlated yet. Run `pnpm correlate`.");
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      anomaly: { type: "string" },
      provider: { type: "string" },
      preview: { type: "boolean" },
      lookback: { type: "string" },
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

  const lookbackHours = values.lookback === undefined ? undefined : Number(values.lookback);
  if (lookbackHours !== undefined && (!Number.isFinite(lookbackHours) || lookbackHours <= 0)) {
    throw new Error(`--lookback must be a positive number of hours, got "${values.lookback}"`);
  }

  const shared = {
    ...(lookbackHours !== undefined ? { lookbackHours } : {}),
    ...(values.repo !== undefined ? { repoPath: values.repo } : {}),
  };

  if (values.preview) {
    // Defaults to the latest real incident; `--anomaly` picks a specific one.
    const prompt = await previewCorrelationPrompt(values.anomaly, shared);
    console.log(
      prompt ??
        (values.anomaly
          ? `No anomaly found with id ${values.anomaly}`
          : "No real incidents yet — run `pnpm detect` and `pnpm classify` first"),
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
  const result = await correlateAnomalies({
    provider,
    limit,
    anomalyId: values.anomaly,
    ...shared,
  });

  console.log(`Provider: ${result.provider} (${result.model})`);

  if (result.outcomes.length === 0) {
    console.log("  nothing to correlate — every real incident already has a correlation");
    return;
  }

  for (const outcome of result.outcomes) reportOutcome(outcome);

  const failed = result.outcomes.filter((o) => o.status === "failed").length;
  if (failed > 0) {
    console.log(`\n${failed} of ${result.outcomes.length} failed; they stay uncorrelated.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
