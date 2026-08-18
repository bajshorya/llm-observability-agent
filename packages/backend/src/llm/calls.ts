/**
 * Cost and latency accounting — the evidence behind the two-tier claim.
 *
 * WHAT THIS FILE DOES
 * Two functions. `recordLlmCall` is the production sink passed to
 * `generateStructured`; it writes one row to `llm_calls` per model invocation.
 * `llmUsageSummary` aggregates those rows per agent, provider and model.
 *
 * WHY THIS TABLE EXISTS
 * The project's central argument is that statistics handle the cheap 90% and
 * the model is invoked only where it earns its cost. That is an empirical
 * claim, and this is what makes it checkable rather than rhetorical: `pnpm
 * classify --stats` reports how many anomalies were raised, how many reached a
 * model, and what those calls cost.
 *
 * EVERY CALL IS RECORDED, INCLUDING THE FAILURES
 * The failed ones matter most. A call that burned tokens across three repair
 * attempts and still produced nothing spent real quota; a table recording only
 * successes would hide exactly the spend worth knowing about, and would make a
 * badly-behaving model look cheap.
 *
 * ATTRIBUTION
 * Aggregation is per (agent, provider, model) because that is the granularity
 * the claim is made at — "the classifier costs X" is a useful sentence, "the
 * system costs X" is not, especially once the correlator and root-cause agents
 * exist and have very different context sizes.
 *
 * WHAT IS DELIBERATELY ABSENT
 * There is no currency column. Every provider in use is free, so a cost figure
 * would read 0.00 and imply a precision that is not there. Tokens and latency
 * are the honest units until a paid provider is added.
 *
 * Eval runs deliberately do NOT write here — see `eval/run.ts`.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { llmCalls } from "../db/schema";
import type { LlmCallSink } from "./structured";

export const recordLlmCall: LlmCallSink = async (record) => {
  await db.insert(llmCalls).values({
    anomalyId: record.anomalyId,
    provider: record.provider,
    model: record.model,
    agent: record.agent,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    latencyMs: Math.round(record.latencyMs),
    repairAttempts: record.repairAttempts,
    succeeded: record.succeeded,
  });
};

export interface LlmUsageRow {
  agent: string;
  provider: string;
  model: string;
  calls: number;
  failed: number;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  avgLatencyMs: number;
}

/** Per-agent usage, which is the granularity the two-tier claim is made at. */
export async function llmUsageSummary(): Promise<LlmUsageRow[]> {
  return db
    .select({
      agent: llmCalls.agent,
      provider: llmCalls.provider,
      model: llmCalls.model,
      calls: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${llmCalls.succeeded} = 0 then 1 else 0 end)`,
      repairAttempts: sql<number>`sum(${llmCalls.repairAttempts})`,
      inputTokens: sql<number | null>`sum(${llmCalls.inputTokens})`,
      outputTokens: sql<number | null>`sum(${llmCalls.outputTokens})`,
      avgLatencyMs: sql<number>`avg(${llmCalls.latencyMs})`,
    })
    .from(llmCalls)
    .groupBy(llmCalls.agent, llmCalls.provider, llmCalls.model)
    .orderBy(llmCalls.agent);
}
