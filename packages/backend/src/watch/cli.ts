/**
 * `pnpm watch` — the whole pipeline on a loop, with a stated spending limit.
 *
 * WHAT THIS FILE DOES
 * Every tick (30s by default):
 *
 *   1. rollup + detect        Tier 1, including silence. Always. Free.
 *   2. classify               only with --classify or --llm
 *   3. correlate              only with --correlate or --llm
 *   4. diagnose               only with --diagnose or --llm
 *   5. alert                  unless --no-alerts. Never calls a model.
 *
 * It contains no pipeline logic. Each stage is the same function its own
 * command calls; this file only sequences them and enforces the budget.
 *
 * WHY THE LLM STAGES ARE STILL OPT-IN
 * "Every stage that spends quota is an explicit act" is the rule this project
 * is built on, and a loop is the easiest place to break it quietly. So a bare
 * `pnpm watch` is free: detection and alerting only. Each paid stage is a flag
 * on the command line, and the most it can spend is `--budget`, printed at
 * start-up and on every tick.
 *
 * HOW THE BUDGET IS ENFORCED
 * Stages run ONE ANOMALY AT A TIME, with the day's spend re-read from
 * `llm_calls` before each. See `budget.ts` for the arithmetic and the one
 * overshoot it allows. A stage stops for the tick on its first failure: the
 * likely causes (an exhausted quota, a missing repository) will not be fixed by
 * trying the next anomaly thirty milliseconds later.
 *
 * WHAT IT ACCEPTS
 * A permanently failing anomaly is retried every tick and, because each stage
 * takes the oldest pending row first, holds up the rows behind it in that
 * stage. Visible — the failure is printed when it first appears and when it
 * changes — and bounded by the budget, but not solved. The fix, if it is ever
 * needed, is a per-row attempt count, which is a schema change.
 */

import { parseArgs } from "node:util";
import { and, eq, gte, sql } from "drizzle-orm";
import { sendPendingAlerts } from "../alerting/notify";
import { classifyAnomalies } from "../classification/classify";
import { correlateAnomalies } from "../correlation/correlate";
import { db } from "../db/client";
import { llmCalls } from "../db/schema";
import { runDetection, type ServiceDetectionResult } from "../detection/engine";
import { runRollup } from "../detection/rollup";
import { diagnoseAnomalies } from "../diagnosis/diagnose";
import { createProvider } from "../llm";
import type { LlmProvider } from "../llm/types";
import {
  describeBudget,
  isFreeProvider,
  remainingRequests,
  utcDayStart,
  type BudgetState,
} from "./budget";

const USAGE = `
The pipeline on a loop. Bare, it is free: detection (including silence) and alerts.

Usage:
  pnpm watch [options]

Options:
  --interval <sec>   Seconds between ticks (default 30)
  --classify         Run Tier 2 on new anomalies (spends quota)
  --correlate        Run commit correlation on real incidents (spends quota)
  --diagnose         Run root cause on attributed incidents (spends quota)
  --llm              All three of the above
  --budget <n>       Max model requests per UTC day across all stages (default 15)
  --no-alerts        Do not send alerts
  --once             Run one tick and exit
  -h, --help         Show this message

The stub and Ollama are local and not budgeted. Alert channels: SLACK_WEBHOOK_URL,
ALERT_WEBHOOK_URL; with neither, alerts print here.
`.trim();

/** Per stage, per tick. Keeps a tick short when a backlog meets a free provider. */
const MAX_PER_STAGE_PER_TICK = 10;

type StageName = "classify" | "correlate" | "diagnose";

interface StageOutcome {
  anomalyId: string;
  status: string;
  error?: string | undefined;
}

interface Options {
  intervalSec: number;
  stages: StageName[];
  budget: number;
  alerts: boolean;
  once: boolean;
}

const clock = (date: Date) => date.toISOString().slice(11, 19);

async function budgetState(provider: LlmProvider, cap: number, now: Date): Promise<BudgetState> {
  if (isFreeProvider(provider.name)) return { cap: null, usedToday: 0 };

  const [row] = await db
    .select({ used: sql<number | null>`sum(1 + ${llmCalls.repairAttempts})` })
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.provider, provider.name),
        eq(llmCalls.model, provider.model),
        gte(llmCalls.createdAt, utcDayStart(now)),
      ),
    );

  return { cap, usedToday: row?.used ?? 0 };
}

function reportDetection(result: ServiceDetectionResult): void {
  if (result.action === "none") return;
  const label = result.action === "created" ? "ANOMALY" : "extended";
  const kinds = result.triggers.map((trigger) => trigger.kind).join(", ");
  console.log(`  detect     ${result.service}: ${label} ${result.anomalyId?.slice(0, 8)} — ${kinds}`);
}

/** Last failure printed per stage+anomaly, so a stuck row is reported once, not every tick. */
const lastFailure = new Map<string, string>();

async function runStage(
  name: StageName,
  run: () => Promise<{ outcomes: StageOutcome[] }>,
  provider: LlmProvider,
  cap: number,
): Promise<void> {
  for (let i = 0; i < MAX_PER_STAGE_PER_TICK; i += 1) {
    const budget = await budgetState(provider, cap, new Date());
    if (remainingRequests(budget) < 1) {
      if (i === 0) console.log(`  ${name.padEnd(10)} skipped — budget spent (${describeBudget(budget)})`);
      return;
    }

    const { outcomes } = await run();
    const outcome = outcomes[0];
    if (!outcome) return;

    const short = outcome.anomalyId.slice(0, 8);
    if (outcome.status === "failed") {
      const key = `${name}|${outcome.anomalyId}`;
      const error = outcome.error ?? "unknown error";
      if (lastFailure.get(key) !== error) {
        console.log(`  ${name.padEnd(10)} ${short} FAILED — ${error}`);
        lastFailure.set(key, error);
      }
      return;
    }

    console.log(`  ${name.padEnd(10)} ${short} ${outcome.status}`);
  }
}

async function tick(options: Options, provider: LlmProvider | null): Promise<void> {
  const now = new Date();
  console.log(`${clock(now)}`);

  await runRollup();
  const detection = await runDetection();
  const fired = [...detection.services, ...detection.silent];
  fired.forEach(reportDetection);

  if (provider) {
    for (const stage of options.stages) {
      try {
        if (stage === "classify") {
          await runStage(stage, () => classifyAnomalies({ provider, limit: 1 }), provider, options.budget);
        } else if (stage === "correlate") {
          await runStage(stage, () => correlateAnomalies({ provider, limit: 1 }), provider, options.budget);
        } else {
          await runStage(stage, () => diagnoseAnomalies({ provider, limit: 1 }), provider, options.budget);
        }
      } catch (error) {
        console.log(`  ${stage.padEnd(10)} error — ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  if (options.alerts) {
    try {
      for (const outcome of await sendPendingAlerts({ now })) {
        const detail = outcome.error ? ` — ${outcome.error}` : "";
        console.log(
          `  alert      ${outcome.anomalyId.slice(0, 8)} ${outcome.reason} → ${outcome.channel} ${outcome.status}${detail}`,
        );
      }
    } catch (error) {
      console.log(`  alert      error — ${error instanceof Error ? error.message : error}`);
    }
  }

  if (provider) {
    console.log(`  budget     ${describeBudget(await budgetState(provider, options.budget, new Date()))}`);
  }
}

function parseOptions(): Options | null {
  const { values } = parseArgs({
    options: {
      interval: { type: "string" },
      classify: { type: "boolean" },
      correlate: { type: "boolean" },
      diagnose: { type: "boolean" },
      llm: { type: "boolean" },
      budget: { type: "string" },
      "no-alerts": { type: "boolean" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return null;
  }

  const intervalSec = values.interval === undefined ? 30 : Number(values.interval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new Error(`--interval must be a positive number of seconds, got "${values.interval}"`);
  }

  const budget = values.budget === undefined ? 15 : Number(values.budget);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`--budget must be a non-negative integer, got "${values.budget}"`);
  }

  const all = values.llm ?? false;
  const stages: StageName[] = [];
  if (all || values.classify) stages.push("classify");
  if (all || values.correlate) stages.push("correlate");
  if (all || values.diagnose) stages.push("diagnose");

  return { intervalSec, stages, budget, alerts: !values["no-alerts"], once: values.once ?? false };
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (!options) return;

  // Only resolved when a paid stage is asked for, so a bare watch needs no key.
  const provider = options.stages.length > 0 ? createProvider() : null;

  console.log(
    provider
      ? `Watching every ${options.intervalSec}s — ${options.stages.join(", ")} via ${provider.name} (${provider.model}), ` +
          (isFreeProvider(provider.name) ? "unbudgeted (local)" : `budget ${options.budget} requests/day`)
      : `Watching every ${options.intervalSec}s — detection${options.alerts ? " and alerts" : ""} only, no model calls`,
  );
  console.log(options.alerts ? "" : "Alerts off.\n");

  if (options.once) {
    await tick(options, provider);
    return;
  }

  let running = true;
  let wake: (() => void) | null = null;
  process.on("SIGINT", () => {
    running = false;
    console.log("\nStopping after this tick.");
    wake?.();
  });

  while (running) {
    try {
      await tick(options, provider);
    } catch (error) {
      // A tick that throws (a locked database, say) must not end the loop.
      console.log(`  tick failed — ${error instanceof Error ? error.message : error}`);
    }
    if (!running) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, options.intervalSec * 1000);
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
