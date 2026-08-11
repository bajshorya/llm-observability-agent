import { parseArgs } from "node:util";
import type { IngestResult } from "@obs/shared";
import { createRng } from "./random";
import {
  BASELINE,
  generateMinute,
  SCENARIO_NAMES,
  SCENARIOS,
  type GeneratedEntry,
  type ScenarioName,
  type TrafficProfile,
} from "./scenarios";

const DEFAULT_INGEST_URL = process.env["INGEST_URL"] ?? "http://localhost:4000/ingest";
const POST_CHUNK_SIZE = 500;
const LIVE_TICK_MS = 5_000;

const USAGE = `
Synthetic log generator for the observability agent.

Usage:
  pnpm generate <command> [options]

Commands:
  backfill    Generate healthy history ending now, so detectors have a baseline.
  live        Emit healthy traffic continuously in real time.
  inject      Emit anomalous traffic ending now. This is the demo trigger.

Scenarios (--scenario):
${SCENARIO_NAMES.map(
  (name) =>
    `  ${name.padEnd(17)} ${SCENARIOS[name].benign ? "[benign]  " : "[incident]"} ${SCENARIOS[name].description}`,
).join("\n")}

  Benign scenarios trip the Tier 1 detectors on purpose. They are what
  Tier 2 exists to dismiss, and what \`pnpm eval\` measures it on.

Options:
  --minutes <n>     Minutes of traffic to generate       (backfill: 120, inject: 5)
  --service <name>  Service name                         (default: ${BASELINE.service})
  --rpm <n>         Requests per minute                  (default: ${BASELINE.requestsPerMinute})
  --seed <n>        PRNG seed for reproducible output     (default: 42)
  --url <url>       Ingestion endpoint                    (default: ${DEFAULT_INGEST_URL})
  -h, --help        Show this message

Examples:
  pnpm generate backfill --minutes 180
  pnpm generate inject --scenario new-error --minutes 5
  pnpm generate live
`.trim();

interface Options {
  minutes: number;
  scenario: ScenarioName | undefined;
  profile: TrafficProfile;
  seed: number;
  url: string;
}

function parseScenario(value: string | undefined): ScenarioName | undefined {
  if (value === undefined) return undefined;
  if ((SCENARIO_NAMES as readonly string[]).includes(value)) {
    return value as ScenarioName;
  }
  throw new Error(
    `Unknown scenario "${value}". Expected one of: ${SCENARIO_NAMES.join(", ")}`,
  );
}

function parsePositiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive number, got "${value}"`);
  }
  return parsed;
}

/** POST entries to the ingestion endpoint in bounded chunks. */
async function send(entries: GeneratedEntry[], url: string): Promise<IngestResult> {
  const total: IngestResult = { accepted: 0, rejected: 0, errors: [] };

  for (let i = 0; i < entries.length; i += POST_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + POST_CHUNK_SIZE);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: chunk }),
      });
    } catch (cause) {
      throw new Error(
        `Could not reach the ingestion endpoint at ${url}. Is the backend running (\`pnpm backend\`)?`,
        { cause },
      );
    }

    if (!response.ok && response.status !== 207) {
      throw new Error(`Ingest failed: ${response.status} ${await response.text()}`);
    }

    const result = (await response.json()) as IngestResult;
    total.accepted += result.accepted;
    total.rejected += result.rejected;
    if (total.errors.length === 0 && result.errors.length > 0) {
      total.errors = result.errors;
    }
  }

  return total;
}

function report(label: string, entries: GeneratedEntry[], result: IngestResult): void {
  const errorCount = entries.filter(
    (e) => e.level === "error" || e.level === "fatal",
  ).length;
  const errorRate = entries.length > 0 ? (errorCount / entries.length) * 100 : 0;

  console.log(
    `${label}: ${result.accepted} accepted, ${result.rejected} rejected ` +
      `(${errorCount} errors, ${errorRate.toFixed(1)}% error rate)`,
  );
  for (const error of result.errors.slice(0, 5)) {
    console.warn(`  rejected entry ${error.index}: ${error.reason}`);
  }
}

/** Generate `minutes` of history ending now, all in one shot. */
async function generateHistory(options: Options, label: string): Promise<void> {
  const rng = createRng(options.seed);
  /**
   * Ends at the last minute boundary rather than at `now`.
   *
   * Rollup buckets and detection windows are both minute-aligned; generated
   * traffic was not, so every run straddled the boundaries differently and the
   * first generated minute was partly clipped out of the window it was meant
   * to land in. That silently cost us the first thing a scenario says — a
   * deploy banner emitted at offset zero fell outside the window it explains.
   * Aligning here makes an injection land on exactly the minutes it claims to.
   */
  const endMs = Math.floor(Date.now() / 60_000) * 60_000;
  const startMs = endMs - options.minutes * 60_000;
  const scenario = options.scenario ? SCENARIOS[options.scenario] : undefined;

  const entries: GeneratedEntry[] = [];
  for (let minute = 0; minute < options.minutes; minute += 1) {
    const windowStart = new Date(startMs + minute * 60_000);
    entries.push(
      ...generateMinute(
        options.profile,
        windowStart,
        rng,
        scenario,
        60_000,
        minute / options.minutes,
      ),
    );
  }

  const result = await send(entries, options.url);
  report(label, entries, result);
}

async function runBackfill(options: Options): Promise<void> {
  console.log(
    `Backfilling ${options.minutes} minutes of healthy ${options.profile.service} traffic...`,
  );
  await generateHistory(options, "Backfill complete");
  console.log(
    "Detectors now have a trailing baseline to compare against — no need to wait in real time.",
  );
}

async function runInject(options: Options): Promise<void> {
  const name = options.scenario;
  if (!name) {
    throw new Error(
      `inject requires --scenario. Expected one of: ${SCENARIO_NAMES.join(", ")}`,
    );
  }
  const scenario = SCENARIOS[name];
  console.log(`Injecting "${name}" for ${options.minutes} minutes:`);
  console.log(`  ${scenario.description}`);
  console.log(
    scenario.benign
      ? "  Tier 1 should fire. Tier 2 should dismiss it — that is the test."
      : "  A real incident: Tier 1 should fire and Tier 2 should confirm it.",
  );
  await generateHistory(options, "Injection complete");
}

async function runLive(options: Options): Promise<void> {
  const rng = createRng(options.seed);
  const scenario = options.scenario ? SCENARIOS[options.scenario] : undefined;
  console.log(
    `Emitting live ${options.profile.service} traffic every ${LIVE_TICK_MS / 1000}s. Ctrl-C to stop.`,
  );

  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\nStopping.");
  });

  while (running) {
    const windowStart = new Date(Date.now() - LIVE_TICK_MS);
    const entries = generateMinute(
      options.profile,
      windowStart,
      rng,
      scenario,
      LIVE_TICK_MS,
    );
    try {
      const result = await send(entries, options.url);
      report(new Date().toISOString().slice(11, 19), entries, result);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, LIVE_TICK_MS));
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      minutes: { type: "string" },
      scenario: { type: "string" },
      service: { type: "string" },
      rpm: { type: "string" },
      seed: { type: "string" },
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];

  if (values.help || command === undefined || command === "help") {
    console.log(USAGE);
    return;
  }

  const defaultMinutes = command === "inject" ? 5 : 120;
  const options: Options = {
    minutes: Math.max(1, Math.round(parsePositiveNumber(values.minutes, defaultMinutes, "minutes"))),
    scenario: parseScenario(values.scenario),
    seed: Math.round(parsePositiveNumber(values.seed, 42, "seed")),
    url: values.url ?? DEFAULT_INGEST_URL,
    profile: {
      ...BASELINE,
      service: values.service ?? BASELINE.service,
      requestsPerMinute: parsePositiveNumber(values.rpm, BASELINE.requestsPerMinute, "rpm"),
    },
  };

  switch (command) {
    case "backfill":
      await runBackfill(options);
      break;
    case "inject":
      await runInject(options);
      break;
    case "live":
      await runLive(options);
      break;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
