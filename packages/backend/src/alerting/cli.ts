/**
 * `pnpm alert` — send any alerts that are due, once.
 *
 * `pnpm watch` calls the same function on every tick; this command exists to
 * run it by hand, and `--dry-run` to see what WOULD be sent without sending or
 * recording anything — the safe first step after setting a webhook URL.
 *
 * Never calls a model. See `notify.ts`.
 */

import { parseArgs } from "node:util";
import { env } from "../env";
import { configuredTargets, sendPendingAlerts } from "./notify";

const USAGE = `
Send due alerts: real incidents at or above ALERT_MIN_SEVERITY (${env.ALERT_MIN_SEVERITY}),
services that have stopped logging, and windows whose logs address the classifier
(suspected prompt injection) when its verdict would not page. Never calls a model.

Usage:
  pnpm alert [options]

Options:
  --dry-run          Print what would be sent; send and record nothing
  --max-age <min>    Only consider anomalies detected this recently (default 360)
  -h, --help         Show this message

Channels: SLACK_WEBHOOK_URL, ALERT_WEBHOOK_URL. With neither, alerts print here.
`.trim();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      "max-age": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const maxAge = values["max-age"] === undefined ? 360 : Number(values["max-age"]);
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error(`--max-age must be a positive number of minutes, got "${values["max-age"]}"`);
  }

  const channels = configuredTargets().map((target) => target.channel).join(", ");
  console.log(`Channels: ${channels}${values["dry-run"] ? " (dry run)" : ""}`);

  const outcomes = await sendPendingAlerts({ dryRun: values["dry-run"] ?? false, maxAgeMinutes: maxAge });

  if (outcomes.length === 0) {
    console.log("Nothing due.");
    return;
  }

  for (const outcome of outcomes) {
    const short = outcome.anomalyId.slice(0, 8);
    const line = `  ${short}  ${outcome.reason.padEnd(9)} ${outcome.channel.padEnd(8)} ${outcome.status}`;
    console.log(outcome.error ? `${line} — ${outcome.error}` : line);
    if (outcome.status === "dry-run") console.log(outcome.message.text.replace(/^/gm, "      "));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
