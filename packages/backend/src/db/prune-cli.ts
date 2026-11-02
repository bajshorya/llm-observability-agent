/**
 * `pnpm retention` — apply the retention policy once. See retention.ts.
 *
 * Not `pnpm prune`: that name is pnpm's own command and shadows any script.
 *
 * `pnpm watch` runs the same function hourly, so this is for a one-off
 * cleanup, a cron job when watch is not the scheduler, or a dry run to see
 * what the policy would delete before trusting it.
 */

import { parseArgs } from "node:util";
import { env } from "../env";
import { pruneOldData } from "./retention";

const USAGE = `
Delete logs and rollups older than the retention policy. Verdicts, correlations,
hypotheses, model calls and alerts are never deleted.

Usage:
  pnpm retention [options]

Options:
  --dry-run            Count what would be deleted; delete nothing
  --log-days <n>       Override LOG_RETENTION_DAYS (now ${env.LOG_RETENTION_DAYS}; 0 keeps forever)
  --rollup-days <n>    Override ROLLUP_RETENTION_DAYS (now ${env.ROLLUP_RETENTION_DAYS}; 0 keeps forever)
  -h, --help           Show this message
`.trim();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      "log-days": { type: "string" },
      "rollup-days": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const policy = {
    logDays: values["log-days"] === undefined ? env.LOG_RETENTION_DAYS : Number(values["log-days"]),
    rollupDays: values["rollup-days"] === undefined ? env.ROLLUP_RETENTION_DAYS : Number(values["rollup-days"]),
  };

  const result = await pruneOldData({ policy, dryRun: values["dry-run"] ?? false });
  const verb = result.dryRun ? "would delete" : "deleted";
  const when = (date: Date | null) => (date ? `older than ${date.toISOString()}` : "kept forever");
  console.log(`logs:    ${verb} ${result.logsDeleted.toLocaleString("en-US")} (${when(result.cutoffs.logsBefore)})`);
  console.log(`rollups: ${verb} ${result.rollupsDeleted.toLocaleString("en-US")} (${when(result.cutoffs.rollupsBefore)})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
