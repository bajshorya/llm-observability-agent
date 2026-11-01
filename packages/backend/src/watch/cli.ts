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
 * start-up and after every tick that printed anything.
 *
 * HOW THE BUDGET IS ENFORCED
 * Stages run ONE ANOMALY AT A TIME, with the day's spend re-read from
 * `llm_calls` before each. See `budget.ts` for the arithmetic and the one
 * overshoot it allows. A stage stops for the tick on its first failure: the
 * likely causes (an exhausted quota, a missing repository) will not be fixed by
 * trying the next anomaly thirty milliseconds later.
 *
 * A FAILING ANOMALY DOES NOT BLOCK THE ONES BEHIND IT
 * Each stage takes the oldest pending row first, so one that fails every time
 * used to be retried every tick and starve the rest. It is now passed over
 * with exponential backoff (1, 2, 4 … ticks, capped at an hour) while the stage
 * proceeds with the others. See `backoff.ts`, including why it is in memory.
 *
 * OUTPUT IS NEWS ONLY
 * A tick prints only if something happened: a new anomaly, a new kind of
 * signal on an existing one, a model call, an alert, a failure the first time
 * it appears. An incident that merely keeps firing is not news. Quiet ticks
 * print a heartbeat every twenty, so a silent terminal still shows it is alive.
 *
 * STOPPING
 * Ctrl-C and SIGTERM both finish the current tick and exit; a second signal
 * exits immediately.
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
import { backedOffIds, isNewFailure, recordFailure, type BackoffEntry } from "./backoff";
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

/**
 * A tick's output is collected and printed only if something happened. An
 * ongoing incident that merely keeps firing is not news; a new anomaly, a new
 * kind of signal on an existing one, a model call or an alert is. Quiet ticks
 * print one heartbeat every `HEARTBEAT_TICKS`, so a silent terminal still
 * proves the loop is alive.
 */
const HEARTBEAT_TICKS = 20;

function describeDetection(result: ServiceDetectionResult): string | null {
  if (result.action === "none" || result.addedKinds.length === 0) return null;
  const label = result.action === "created" ? "ANOMALY" : "now also";
  return `  detect     ${result.service}: ${label} ${result.anomalyId?.slice(0, 8)} — ${result.addedKinds.join(", ")}`;
}

/** Failing anomalies per stage, passed over with exponential backoff. See backoff.ts. */
const backoff: Record<StageName, Map<string, BackoffEntry>> = {
  classify: new Map(),
  correlate: new Map(),
  diagnose: new Map(),
};

/** The UTC day each stage last announced a spent budget, so it is said once. */
const budgetNoticeDay = new Map<StageName, string>();

async function runStage(
  name: StageName,
  run: (excludeIds: string[]) => Promise<{ outcomes: StageOutcome[] }>,
  provider: LlmProvider,
  cap: number,
  tickNumber: number,
  out: string[],
): Promise<void> {
  const entries = backoff[name];

  for (let i = 0; i < MAX_PER_STAGE_PER_TICK; i += 1) {
    const budget = await budgetState(provider, cap, new Date());
    if (remainingRequests(budget) < 1) {
      // Once per stage per UTC day: the moment it happens, not every tick after.
      const day = utcDayStart(new Date()).toISOString();
      if (budgetNoticeDay.get(name) !== day) {
        budgetNoticeDay.set(name, day);
        out.push(`  ${name.padEnd(10)} paused — budget spent (${describeBudget(budget)}); resumes at 00:00 UTC`);
      }
      return;
    }

    const { outcomes } = await run(backedOffIds(entries, tickNumber));
    const outcome = outcomes[0];
    if (!outcome) return;

    const short = outcome.anomalyId.slice(0, 8);
    if (outcome.status === "failed") {
      const error = outcome.error ?? "unknown error";
      const previous = entries.get(outcome.anomalyId);
      const next = recordFailure(previous, tickNumber, error);
      entries.set(outcome.anomalyId, next);
      if (isNewFailure(previous, error)) {
        out.push(
          `  ${name.padEnd(10)} ${short} FAILED — ${error} ` +
            `(retrying in ${next.retryAtTick - tickNumber} tick(s); others proceed meanwhile)`,
        );
      }
      // Stop the stage for this tick: the likely causes (quota, a missing
      // repository) would fail the next anomaly too.
      return;
    }

    entries.delete(outcome.anomalyId);
    out.push(`  ${name.padEnd(10)} ${short} ${outcome.status}`);
  }
}

let quietTicks = 0;

async function tick(options: Options, provider: LlmProvider | null, tickNumber: number): Promise<void> {
  const now = new Date();
  const out: string[] = [];

  await runRollup();
  const detection = await runDetection();
  for (const result of [...detection.silent, ...detection.services]) {
    const line = describeDetection(result);
    if (line) out.push(line);
  }

  if (provider) {
    for (const stage of options.stages) {
      try {
        if (stage === "classify") {
          await runStage(stage, (excludeIds) => classifyAnomalies({ provider, limit: 1, excludeIds }), provider, options.budget, tickNumber, out);
        } else if (stage === "correlate") {
          await runStage(stage, (excludeIds) => correlateAnomalies({ provider, limit: 1, excludeIds }), provider, options.budget, tickNumber, out);
        } else {
          await runStage(stage, (excludeIds) => diagnoseAnomalies({ provider, limit: 1, excludeIds }), provider, options.budget, tickNumber, out);
        }
      } catch (error) {
        out.push(`  ${stage.padEnd(10)} error — ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  if (options.alerts) {
    try {
      for (const outcome of await sendPendingAlerts({ now })) {
        const detail = outcome.error ? ` — ${outcome.error}` : "";
        out.push(
          `  alert      ${outcome.anomalyId.slice(0, 8)} ${outcome.reason} → ${outcome.channel} ${outcome.status}${detail}`,
        );
      }
    } catch (error) {
      out.push(`  alert      error — ${error instanceof Error ? error.message : error}`);
    }
  }

  if (out.length === 0) {
    quietTicks += 1;
    if (quietTicks % HEARTBEAT_TICKS === 0 || options.once) {
      console.log(`${clock(now)}  quiet — nothing new in ${quietTicks} tick(s)`);
    }
    return;
  }

  quietTicks = 0;
  console.log(clock(now));
  out.forEach((line) => console.log(line));

  // The budget line only where there is a budget: the stub and Ollama are free.
  if (provider && !isFreeProvider(provider.name)) {
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
    await tick(options, provider, 0);
    return;
  }

  /**
   * SIGINT (Ctrl-C) and SIGTERM (docker stop, systemd, kill) both stop the loop
   * after the current tick, so a stage is never cut off between its model call
   * and the row that records it. A second signal exits at once, for when that
   * tick is stuck on a slow provider.
   */
  let running = true;
  let wake: (() => void) | null = null;
  const stop = (signal: NodeJS.Signals) => {
    if (!running) {
      console.log(`\n${signal} again — exiting now.`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    running = false;
    console.log(`\n${signal} — stopping after this tick. Send it again to exit now.`);
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (let tickNumber = 0; running; tickNumber += 1) {
    try {
      await tick(options, provider, tickNumber);
    } catch (error) {
      // A tick that throws (a locked database, say) must not end the loop.
      console.log(`${clock(new Date())}  tick failed — ${error instanceof Error ? error.message : error}`);
    }
    if (!running) break;
    // The timer is cleared on wake: a pending 30s timeout would otherwise keep
    // the process alive for up to an interval after it said it was stopping.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalSec * 1000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  console.log("Stopped.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
