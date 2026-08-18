/**
 * `pnpm detect` — the Tier 1 operator interface.
 *
 * WHAT THIS FILE DOES
 * Runs the rollup worker, then the detection engine, and prints what happened
 * in a form a human can read at a glance. It is presentation only: every
 * decision belongs to `rollup.ts` and `engine.ts`.
 *
 * WHY A COMMAND AND NOT A DAEMON
 * Detection is idempotent and cheap, so running it on an interval from outside —
 * cron, a shell loop, or `--watch` — keeps the moving parts obvious while
 * developing. A long-lived scheduler would add failure modes (drift, missed
 * ticks, restarts) for no benefit at this stage.
 *
 * OPTIONS
 *   --rollup-only   compute aggregates and stop
 *   --detect-only   run detectors against existing rollups
 *   --classify      also run Tier 2 over anything new
 *   --watch <sec>   repeat, default 30s when the flag is bare
 *
 * WHY `--classify` IS OPT-IN
 * This is the whole two-tier design expressed as a flag. Tier 1 is free and can
 * run every thirty seconds; Tier 2 spends quota and should not. Making the
 * expensive stage an explicit choice keeps the cheap loop cheap — and keeps the
 * claim "the statistical layer works on its own" true and checkable rather than
 * merely asserted.
 *
 * OUTPUT
 * A firing window prints each trigger with the evidence that justified it —
 * observed counts against baseline mean and σ, the z-score, the ratio, the
 * novel signature with a raw sample message. The goal is that the alert is
 * understandable WITHOUT opening the database, because that is what an operator
 * actually needs at 3am.
 */

import { parseArgs } from "node:util";
import type { AnomalyTrigger } from "@obs/shared";
import { classifyAnomalies } from "../classification/classify";
import { env } from "../env";
import { detectionConfig } from "./config";
import { runDetection, type ServiceDetectionResult } from "./engine";
import { runRollup } from "./rollup";

const USAGE = `
Tier 1 detection — statistical only, no LLM.

Usage:
  pnpm detect [options]

Options:
  --rollup-only     Compute per-minute aggregates and stop
  --detect-only     Run detectors against existing rollups
  --classify        Also run Tier 2 (LLM) over anything new — see \`pnpm classify\`
  --watch <sec>     Repeat every <sec> seconds (default 30 when flag is bare)
  -h, --help        Show this message

Configuration lives in src/detection/config.ts:
  window ${detectionConfig.windowMinutes} min | baseline ${detectionConfig.baselineMinutes} min | k=${detectionConfig.errorRate.stdDevMultiplier} | latency ratio ${detectionConfig.latency.ratioThreshold}x
`.trim();

const clock = (date: Date): string => date.toISOString().slice(11, 16);

function describeTrigger(trigger: AnomalyTrigger): string {
  switch (trigger.kind) {
    case "error_rate_spike":
      return (
        `error_rate_spike     ${trigger.observedErrors} errors in window; ` +
        `baseline ${trigger.baselineMean}/min ±${trigger.baselineStdDev}, z=${trigger.zScore}`
      );
    case "latency_jump":
      return (
        `latency_jump         ${trigger.metric} ${trigger.observedMs}ms vs ` +
        `baseline ${trigger.baselineMs}ms (${trigger.ratio}x)`
      );
    case "new_error_signature":
      return (
        `new_error_signature  "${trigger.signature}" x${trigger.occurrences}\n` +
        `                       sample: ${trigger.sampleMessage}`
      );
  }
}

function reportService(result: ServiceDetectionResult): void {
  if (result.skippedReason) {
    console.log(`  ${result.service}: skipped — ${result.skippedReason}`);
    return;
  }

  if (result.triggers.length === 0) {
    console.log(`  ${result.service}: clean`);
    return;
  }

  const label = result.action === "created" ? "ANOMALY created" : "anomaly extended";
  console.log(`  ${result.service}: ${label}  ${result.anomalyId?.slice(0, 8) ?? ""}`);
  for (const trigger of result.triggers) {
    console.log(`    - ${describeTrigger(trigger)}`);
  }
}

/**
 * Chain Tier 2 onto a detection run.
 *
 * Off by default. Tier 1 is free and can run every thirty seconds; Tier 2
 * spends quota, so making it opt-in keeps the cheap loop cheap and keeps the
 * cost of the expensive one an explicit choice.
 */
async function runClassification(): Promise<void> {
  const result = await classifyAnomalies();

  if (result.outcomes.length === 0) return;

  console.log(`Tier 2 via ${result.provider} (${result.model}):`);
  for (const outcome of result.outcomes) {
    const short = outcome.anomalyId.slice(0, 8);
    if (outcome.status === "failed") {
      console.log(`  ${short}: FAILED — ${outcome.error}`);
      continue;
    }
    const verdict = outcome.classification;
    if (!verdict) continue;
    console.log(
      `  ${short}: ${verdict.severity.toUpperCase()} ` +
        `(${verdict.isRealIncident ? "incident" : "dismissed"}) — ${verdict.summary}`,
    );
  }
}

interface RunOptions {
  rollupOnly: boolean;
  detectOnly: boolean;
  classify: boolean;
}

async function runOnce({ rollupOnly, detectOnly, classify }: RunOptions): Promise<void> {
  if (!detectOnly) {
    const rollup = await runRollup();
    if (rollup.logsRead === 0) {
      console.log("Rollup: nothing new to aggregate");
    } else {
      console.log(
        `Rollup: ${rollup.logsRead} logs -> ${rollup.bucketsWritten} buckets ` +
          `(${rollup.from ? clock(rollup.from) : "?"} to ${rollup.to ? clock(rollup.to) : "?"})`,
      );
    }
    if (rollupOnly) return;
  }

  const detection = await runDetection();
  console.log(
    `Window ${clock(detection.windowStart)} to ${clock(detection.windowEnd)} ` +
      `(baseline ${detectionConfig.baselineMinutes} min):`,
  );

  if (detection.services.length === 0) {
    console.log("  no services with rollup data yet");
    return;
  }

  for (const service of detection.services) reportService(service);

  if (classify) await runClassification();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "rollup-only": { type: "boolean" },
      "detect-only": { type: "boolean" },
      classify: { type: "boolean" },
      watch: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const options: RunOptions = {
    rollupOnly: values["rollup-only"] ?? false,
    detectOnly: values["detect-only"] ?? false,
    classify: values.classify ?? false,
  };

  if (options.classify) {
    console.log(`Tier 2 enabled — provider: ${env.LLM_PROVIDER}\n`);
  }

  if (values.watch === undefined) {
    await runOnce(options);
    return;
  }

  const intervalSec = values.watch === "" ? 30 : Number(values.watch);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new Error(`--watch must be a positive number of seconds, got "${values.watch}"`);
  }

  console.log(`Watching every ${intervalSec}s. Ctrl-C to stop.\n`);
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\nStopping.");
  });

  while (running) {
    await runOnce(options);
    console.log("");
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
