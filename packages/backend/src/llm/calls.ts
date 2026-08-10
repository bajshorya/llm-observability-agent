import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { llmCalls } from "../db/schema";
import type { LlmCallSink } from "./structured";

/**
 * Cost and latency accounting.
 *
 * Every invocation lands here, successful or not. The failed ones matter most:
 * a run that burned tokens on three repair attempts and still produced nothing
 * cost real quota, and a cost table that only records successes would hide
 * exactly the spend worth knowing about.
 */

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
