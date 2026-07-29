import { parseArgs } from "node:util";
import type { AnomalyTrigger } from "@obs/shared";
import { detectionConfig } from "./config";
import { runDetection, type ServiceDetectionResult } from "./engine";
import { runRollup } from "./rollup";

/**
 * Tier 1 CLI: roll up, then detect.
 *
 * Deliberately a one-shot command rather than a daemon. Detection is
 * idempotent and cheap, so running it on an interval from outside (or via
 * --watch) keeps the moving parts obvious while developing.
 */

const USAGE = `
Tier 1 detection — statistical only, no LLM.

Usage:
  pnpm detect [options]

Options:
  --rollup-only     Compute per-minute aggregates and stop
  --detect-only     Run detectors against existing rollups
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

async function runOnce(rollupOnly: boolean, detectOnly: boolean): Promise<void> {
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
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "rollup-only": { type: "boolean" },
      "detect-only": { type: "boolean" },
      watch: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const rollupOnly = values["rollup-only"] ?? false;
  const detectOnly = values["detect-only"] ?? false;

  if (values.watch === undefined) {
    await runOnce(rollupOnly, detectOnly);
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
    await runOnce(rollupOnly, detectOnly);
    console.log("");
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
