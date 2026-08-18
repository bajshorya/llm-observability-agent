/**
 * `generateStructured` — the one function every LLM agent calls.
 *
 * WHAT THIS FILE DOES
 * Prompt in, schema-valid object out. It is the only place in the system where
 * a model response becomes typed data, and nothing downstream of it ever
 * consumes free-form model text.
 *
 * THE LOOP
 *
 *     call provider
 *         → extract JSON        (json.ts, handles fences and preamble)
 *         → schema.safeParse    (Zod)
 *         → valid?   yes → return { value, stats }
 *                    no  → re-prompt with the model's OWN OUTPUT and the
 *                          specific validation errors, up to maxRepairAttempts
 *         → still invalid → throw LlmStructuredError
 *
 * WHY THE REPAIR PROMPT INCLUDES THE PREVIOUS RESPONSE
 * Telling a model "that was invalid" without showing it what "that" was
 * produces a second guess rather than a correction. It also re-sends the
 * original evidence, so the model is correcting its answer rather than
 * answering a new question with less context.
 *
 * Capped at two repairs: a model that cannot produce the shape twice in a row
 * will not produce it on the fifth try, and every retry costs real tokens —
 * without a ceiling the cost table would quietly fill with them.
 *
 * TRANSPORT FAILURES SKIP THE LOOP ENTIRELY
 * A `LlmProviderError` means the call did not happen properly, not that the
 * answer was wrong. HTTP-level retries have already occurred inside the
 * provider, and no amount of re-prompting fixes a bad API key. The cost of the
 * failed call is recorded and the error propagates.
 *
 * NO DATABASE IMPORT IN THIS FILE — DELIBERATELY
 * Cost records go to an INJECTED SINK (`onCall`) rather than being written
 * here. That keeps the retry and validation logic testable with a fake provider
 * and no I/O at all, exactly the way the Tier 1 detectors are testable. The
 * caller passes `recordLlmCall` in production; tests pass an array.
 *
 * WHAT GETS RECORDED
 * One row per invocation whatever the outcome, with tokens summed across every
 * attempt, total wall-clock latency, the repair count, and success. Failures
 * are recorded too — a call that burned tokens over three attempts and produced
 * nothing still spent quota, and a table that logged only successes would hide
 * exactly the spend worth knowing about.
 */

import type { z } from "zod";
import type { LlmAgent, LlmCallStats } from "@obs/shared";
import { llmConfig, type LlmConfig } from "./config";
import { parseJsonObject } from "./json";
import { LlmProviderError, type LlmProvider } from "./types";

export interface LlmCallRecord extends LlmCallStats {
  anomalyId: string | null;
}

export type LlmCallSink = (record: LlmCallRecord) => Promise<void> | void;

export interface StructuredOptions<T> {
  provider: LlmProvider;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  agent: LlmAgent;
  /** Recorded on the cost row so spend can be traced to an incident. */
  anomalyId?: string | null;
  onCall?: LlmCallSink;
  config?: LlmConfig;
}

export interface StructuredResult<T> {
  value: T;
  stats: LlmCallStats;
}

/** Thrown when the model could not be made to produce the required shape. */
export class LlmStructuredError extends Error {
  constructor(
    message: string,
    readonly agent: LlmAgent,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "LlmStructuredError";
  }
}

/** Zod issues as short `path: message` lines the model can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return `- ${path || "(root)"}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * The repair prompt. Deliberately includes the model's own output: telling it
 * "that was invalid" without showing what "that" was produces a second guess
 * rather than a correction.
 */
function repairPrompt(original: string, response: string, problem: string): string {
  return [
    original,
    "",
    "---",
    "Your previous response could not be used.",
    "",
    "Previous response:",
    response.slice(0, 1500),
    "",
    "Problem:",
    problem,
    "",
    "Return a corrected JSON object matching the required schema exactly.",
    "Output the object and nothing else — no explanation, no markdown fences.",
  ].join("\n");
}

/** Sum reported token counts; stay null when no attempt reported any. */
function sumTokens(values: readonly (number | null)[]): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length > 0 ? reported.reduce((a, b) => a + b, 0) : null;
}

export async function generateStructured<T>(
  options: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const {
    provider,
    schema,
    system,
    agent,
    anomalyId = null,
    onCall,
    config = llmConfig,
  } = options;

  const startedAt = Date.now();
  const inputTokens: (number | null)[] = [];
  const outputTokens: (number | null)[] = [];

  let user = options.user;
  let failures = 0;
  let lastProblem = "unknown";

  const finish = async (succeeded: boolean): Promise<LlmCallStats> => {
    const stats: LlmCallStats = {
      provider: provider.name,
      model: provider.model,
      agent,
      inputTokens: sumTokens(inputTokens),
      outputTokens: sumTokens(outputTokens),
      latencyMs: Date.now() - startedAt,
      repairAttempts: failures,
      succeeded,
    };
    await onCall?.({ ...stats, anomalyId });
    return stats;
  };

  // One initial attempt, then up to `maxRepairAttempts` corrections.
  for (let attempt = 0; attempt <= config.maxRepairAttempts; attempt += 1) {
    let completion;

    try {
      completion = await provider.complete({
        system,
        user,
        agent,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
      });
    } catch (error) {
      /**
       * A transport failure is not a schema failure. HTTP-level retries have
       * already happened inside the provider, and no amount of re-prompting
       * fixes a bad key or a retired model — so record the cost of the failed
       * call and let it out.
       */
      await finish(false);
      throw error instanceof LlmProviderError
        ? error
        : new LlmProviderError(String(error), provider.name);
    }

    inputTokens.push(completion.inputTokens);
    outputTokens.push(completion.outputTokens);

    const parsed = parseJsonObject(completion.text);

    if (parsed === null) {
      failures += 1;
      lastProblem = "The response did not contain a parseable JSON object.";
      user = repairPrompt(options.user, completion.text, lastProblem);
      continue;
    }

    const result = schema.safeParse(parsed);

    if (result.success) {
      const stats = await finish(true);
      return { value: result.data, stats };
    }

    failures += 1;
    lastProblem = `The JSON did not match the schema:\n${describeIssues(result.error)}`;
    user = repairPrompt(options.user, completion.text, lastProblem);
  }

  await finish(false);
  throw new LlmStructuredError(
    `${agent}: no schema-valid response after ${failures} attempt(s). Last problem: ${lastProblem}`,
    agent,
    failures,
  );
}
